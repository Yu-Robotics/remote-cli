import { BindingCode, DeviceBinding, UserBinding } from '../types';
import { JsonStore } from '../storage/JsonStore';
import { randomInt } from 'crypto';

export interface BindingRedemption {
  bindingCode: BindingCode;
  alreadyBound: boolean;
  isFirstDevice: boolean;
}

/** Serializes ownership mutations sharing one JsonStore, including key callbacks. */
export class BindingManager {
  private store: JsonStore;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(store: JsonStore) {
    this.store = store;
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async generateBindingCode(deviceId: string, deviceName: string, devicePublicKey?: string): Promise<BindingCode> {
    return this.mutate(async () => {
      const code = this.generateRandomCode();
      const now = Date.now();
      const bindingCode: BindingCode = {
        code,
        deviceId,
        ...(devicePublicKey ? { devicePublicKey } : {}),
        createdAt: now,
        expiresAt: now + 5 * 60 * 1000,
      };
      await this.store.setBindingCode(code, bindingCode);
      return bindingCode;
    });
  }

  async verifyBindingCode(code: string): Promise<BindingCode | null> {
    return this.store.getBindingCode(code);
  }

  async consumeBindingCode(code: string): Promise<void> {
    return this.mutate(() => this.store.deleteBindingCode(code));
  }

  /** Validate, assign, enroll, and consume without admitting competing mutations. */
  async redeemBindingCode(openId: string, code: string, deviceName: string,
    approveDeviceKey?: (openId: string, deviceId: string, publicKey: string) => Promise<void>): Promise<BindingRedemption | null> {
    return this.mutate(async () => {
      const bindingCode = this.store.getBindingCode(code);
      if (!bindingCode) return null;
      if (bindingCode.devicePublicKey && !approveDeviceKey) throw new Error('Secure device enrollment is unavailable.');
      this.assertOwnership(bindingCode.deviceId, openId);
      const existingDevices = this.store.getUserBinding(openId)?.devices ?? [];
      const alreadyBound = existingDevices.some(device => device.deviceId === bindingCode.deviceId);
      if (alreadyBound && !bindingCode.devicePublicKey) {
        return { bindingCode, alreadyBound, isFirstDevice: existingDevices.length === 0 };
      }

      await this.bindUserLocked(openId, bindingCode.deviceId, deviceName);
      if (bindingCode.devicePublicKey) {
        await approveDeviceKey!(openId, bindingCode.deviceId, bindingCode.devicePublicKey);
      }
      await this.store.deleteBindingCode(code);
      return { bindingCode, alreadyBound, isFirstDevice: existingDevices.length === 0 };
    });
  }

  async bindUser(openId: string, deviceId: string, deviceName: string): Promise<void> {
    return this.mutate(() => this.bindUserLocked(openId, deviceId, deviceName));
  }

  private async bindUserLocked(openId: string, deviceId: string, deviceName: string): Promise<void> {
    this.assertOwnership(deviceId, openId);
    const now = Date.now();
    const existingBinding = this.store.getUserBinding(openId);
    if (existingBinding) {
      const deviceIndex = existingBinding.devices.findIndex(device => device.deviceId === deviceId);
      if (deviceIndex >= 0) {
        existingBinding.devices[deviceIndex] = {
          ...existingBinding.devices[deviceIndex], deviceName, lastActiveAt: now,
        };
      } else {
        existingBinding.devices.push({ deviceId, deviceName, boundAt: now, lastActiveAt: now, isActive: false });
      }
      existingBinding.updatedAt = now;
      await this.store.setUserBinding(openId, existingBinding);
    } else {
      const binding: UserBinding = {
        openId,
        devices: [{ deviceId, deviceName, boundAt: now, lastActiveAt: now, isActive: true }],
        activeDeviceId: deviceId,
        createdAt: now,
        updatedAt: now,
      };
      await this.store.setUserBinding(openId, binding);
    }
    await this.store.setDeviceToUserMap(deviceId, openId);
  }

  /** Detect conflicting records rather than silently choosing or repairing an owner. */
  private assertOwnership(deviceId: string, openId: string): void {
    const owners: string[] = [];
    for (const candidate of this.store.listBoundUserIds()) {
      if (this.store.getUserBinding(candidate)?.devices.some(device => device.deviceId === deviceId)) owners.push(candidate);
    }
    const mapped = this.store.getUserByDeviceId(deviceId);
    const ambiguous = owners.length > 1 || Boolean(mapped && owners.length > 0 && !owners.includes(mapped));
    if (ambiguous) {
      throw new Error(`Device ${deviceId} has ambiguous historical ownership. Repair the binding records manually before changing them.`);
    }
    const owner = mapped ?? owners[0];
    if (owner && owner !== openId) {
      throw new Error(`Device ${deviceId} is already bound to another user. Please unbind it first or use a different device ID.`);
    }
  }

  async getUserBinding(openId: string): Promise<UserBinding | null> {
    return this.store.getUserBinding(openId);
  }

  async listBoundUserIds(): Promise<string[]> {
    return this.store.listBoundUserIds();
  }

  async getUserDevices(openId: string): Promise<DeviceBinding[]> {
    return this.store.getUserBinding(openId)?.devices ?? [];
  }

  async getActiveDevice(openId: string): Promise<DeviceBinding | null> {
    const binding = this.store.getUserBinding(openId);
    if (!binding?.activeDeviceId) return null;
    return binding.devices.find(device => device.deviceId === binding.activeDeviceId) ?? null;
  }

  async switchActiveDevice(openId: string, deviceId: string): Promise<boolean> {
    return this.mutate(async () => {
      const binding = this.store.getUserBinding(openId);
      if (!binding?.devices.some(device => device.deviceId === deviceId)) return false;
      binding.devices = binding.devices.map(device => ({ ...device, isActive: device.deviceId === deviceId }));
      binding.activeDeviceId = deviceId;
      binding.updatedAt = Date.now();
      await this.store.setUserBinding(openId, binding);
      return true;
    });
  }

  async unbindDevice(openId: string, deviceId: string,
    beforeUnbind?: (deviceId: string) => Promise<void>): Promise<boolean> {
    return this.mutate(async () => {
      const binding = this.store.getUserBinding(openId);
      const deviceIndex = binding?.devices.findIndex(device => device.deviceId === deviceId) ?? -1;
      if (!binding || deviceIndex < 0) return false;
      this.assertOwnership(deviceId, openId);
      await beforeUnbind?.(deviceId);
      return this.store.unbindDevice(openId, deviceId);
    });
  }

  async getDeviceBinding(deviceId: string): Promise<UserBinding | null> {
    const openId = this.store.getUserByDeviceId(deviceId);
    return openId ? this.store.getUserBinding(openId) : null;
  }

  async unbindUser(openId: string, beforeUnbind?: (deviceId: string) => Promise<void>): Promise<void> {
    return this.mutate(async () => {
      const binding = this.store.getUserBinding(openId);
      if (!binding) return;
      for (const device of binding.devices) this.assertOwnership(device.deviceId, openId);
      if (beforeUnbind) for (const device of binding.devices) await beforeUnbind(device.deviceId);
      await this.store.deleteUserBinding(openId);
    });
  }

  async updateLastActive(openId: string): Promise<void> {
    return this.mutate(() => this.store.updateLastActive(openId));
  }

  private generateRandomCode(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const segments = [];
    for (let i = 0; i < 3; i++) {
      let segment = '';
      for (let j = 0; j < 3; j++) segment += chars.charAt(randomInt(chars.length));
      segments.push(segment);
    }
    return segments.join('-');
  }

  async close(): Promise<void> {
    await this.mutationTail;
    await this.store.flush();
  }
}
