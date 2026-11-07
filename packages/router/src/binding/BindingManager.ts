import { BindingCode, DeviceBinding, UserBinding } from '../types';
import { JsonStore } from '../storage/JsonStore';
import { randomInt } from 'crypto';

export interface BindingRedemption {
  bindingCode: BindingCode;
  alreadyBound: boolean;
  isFirstDevice: boolean;
  /** Fresh first-key enrollment, including a retry after a failed key write. */
  newDeviceEnrollment?: boolean;
}

export type DeviceEnrollmentBoundary = (deviceId: string, phase: 'begin' | 'end') => void;

// Router and Feishu handlers construct separate managers over the same store.
// Keep callbacks inside their shared queue so ownership cannot change mid-enrollment.
const mutationQueues = new WeakMap<JsonStore, { tail: Promise<void> }>();

/** Serializes ownership mutations sharing one JsonStore, including key callbacks. */
export class BindingManager {
  private store: JsonStore;
  private readonly mutations: { tail: Promise<void> };

  constructor(store: JsonStore) {
    this.store = store;
    let mutations = mutationQueues.get(store);
    if (!mutations) {
      mutations = { tail: Promise.resolve() };
      mutationQueues.set(store, mutations);
    }
    this.mutations = mutations;
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.tail.then(operation);
    this.mutations.tail = result.then(() => undefined, () => undefined);
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
    approveDeviceKey?: (openId: string, deviceId: string, publicKey: string) => Promise<void>,
    enrollmentBoundary?: DeviceEnrollmentBoundary): Promise<BindingRedemption | null> {
    return this.mutate(async () => {
      const bindingCode = this.store.getBindingCode(code);
      if (!bindingCode) return null;
      if (bindingCode.devicePublicKey && !approveDeviceKey) throw new Error('Secure device enrollment is unavailable.');
      this.assertOwnership(bindingCode.deviceId, openId);
      const existingDevices = this.store.getUserBinding(openId)?.devices ?? [];
      const existingDevice = existingDevices.find(device => device.deviceId === bindingCode.deviceId);
      const alreadyBound = Boolean(existingDevice);
      if (alreadyBound && !bindingCode.devicePublicKey) {
        return { bindingCode, alreadyBound, isFirstDevice: existingDevices.length === 0 };
      }

      const newDeviceEnrollment = Boolean(bindingCode.devicePublicKey
        && (!alreadyBound || existingDevice?.requiresDeviceAuth));
      const excludeLegacy = Boolean(bindingCode.devicePublicKey && !alreadyBound);
      if (excludeLegacy) enrollmentBoundary?.(bindingCode.deviceId, 'begin');
      try {
        await this.bindUserLocked(openId, bindingCode.deviceId, deviceName, newDeviceEnrollment);
        if (bindingCode.devicePublicKey) {
          await approveDeviceKey!(openId, bindingCode.deviceId, bindingCode.devicePublicKey);
        }
        if (newDeviceEnrollment) await this.clearDeviceAuthRequirementLocked(openId, bindingCode.deviceId);
        await this.store.deleteBindingCode(code);
        return { bindingCode, alreadyBound, isFirstDevice: existingDevices.length === 0, newDeviceEnrollment };
      } finally {
        if (excludeLegacy) enrollmentBoundary?.(bindingCode.deviceId, 'end');
      }
    });
  }

  async bindUser(openId: string, deviceId: string, deviceName: string): Promise<void> {
    return this.mutate(() => this.bindUserLocked(openId, deviceId, deviceName));
  }

  /** Approve only an unchanged existing binding, serialized with unbind and manual enrollment. */
  async approveExistingDeviceKey(openId: string, deviceId: string, epoch: string,
    approve: () => Promise<void>): Promise<void> {
    return this.mutate(async () => {
      this.assertOwnership(deviceId, openId);
      const binding = this.store.getUserBinding(openId);
      if (!binding?.devices.some(device => device.deviceId === deviceId)
        || !epoch || this.getCardThreadEpoch(openId, deviceId) !== epoch) throw new Error('Device ownership changed.');
      await approve();
    });
  }

  private async bindUserLocked(openId: string, deviceId: string, deviceName: string, requireDeviceAuth = false): Promise<void> {
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
        existingBinding.devices.push({ deviceId, deviceName, boundAt: now, lastActiveAt: now, isActive: false,
          ...(requireDeviceAuth ? { requiresDeviceAuth: true } : {}) });
      }
      existingBinding.updatedAt = now;
      await this.store.setUserBinding(openId, existingBinding);
    } else {
      const binding: UserBinding = {
        openId,
        devices: [{ deviceId, deviceName, boundAt: now, lastActiveAt: now, isActive: true,
          ...(requireDeviceAuth ? { requiresDeviceAuth: true } : {}) }],
        activeDeviceId: deviceId,
        createdAt: now,
        updatedAt: now,
      };
      await this.store.setUserBinding(openId, binding);
    }
    await this.store.setDeviceToUserMap(deviceId, openId);
  }

  private async clearDeviceAuthRequirementLocked(openId: string, deviceId: string): Promise<void> {
    this.assertOwnership(deviceId, openId);
    const binding = this.store.getUserBinding(openId);
    const device = binding?.devices.find(item => item.deviceId === deviceId);
    if (!binding || !device) throw new Error('Device ownership changed during key enrollment.');
    if (!device.requiresDeviceAuth) return;
    binding.devices = binding.devices.map(item => {
      if (item.deviceId !== deviceId) return item;
      const { requiresDeviceAuth: _cleared, ...enrolled } = item;
      return enrolled;
    });
    binding.updatedAt = Date.now();
    await this.store.setUserBinding(openId, binding);
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

  getCardThreadEpoch(openId: string, deviceId: string): string {
    return this.store.getCardThreadEpoch(openId, deviceId);
  }

  async invalidateDeviceCards(deviceId: string): Promise<void> {
    // May run inside an ownership mutation's beforeUnbind callback.
    await this.store.invalidateDeviceCards(deviceId);
  }

  getThreadSelection(openId: string, deviceId: string) {
    return this.store.getDeviceThreadSelection(openId, deviceId);
  }

  async selectThread(openId: string, deviceId: string, threadId: string,
    guard: () => boolean = () => true, onCommitAdmitted?: () => void): Promise<boolean> {
    return this.mutate(async () => {
      if (!guard()) return false;
      this.assertOwnership(deviceId, openId);
      return this.store.setDeviceThreadSelection(openId, deviceId, threadId, { requireActive: true, guard, onCommitAdmitted });
    });
  }

  async clearThreadSelection(openId: string, deviceId: string, expectedThreadId: string,
    guard: () => boolean = () => true): Promise<boolean> {
    return this.mutate(async () => {
      if (!guard()) return false;
      this.assertOwnership(deviceId, openId);
      return this.store.setDeviceThreadSelection(openId, deviceId, null, { expectedThreadId, guard });
    });
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
    await this.mutations.tail;
    await this.store.flush();
  }
}
