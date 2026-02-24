import { BindingCode, UserBinding, LegacyUserBinding } from '../types';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

interface StoreData {
  version: number;
  bindingCodes: Record<string, BindingCode>;
  userBindings: Record<string, UserBinding>;
  deviceToUserMap: Record<string, string>;
}

/**
 * JSON file-based storage for bindings
 * Persists data across router restarts
 */
export class JsonStore {
  private storePath: string;
  private data: StoreData;
  private saveTimer: NodeJS.Timeout | null = null;
  private pendingResolvers: Array<() => void> = [];
  private readonly SAVE_DELAY: number;
  private static readonly CURRENT_VERSION = 1;

  constructor(storePath?: string, saveDelay = 1000) {
    this.storePath = storePath || path.join(os.homedir(), '.remote-cli-router', 'bindings.json');
    this.SAVE_DELAY = saveDelay;
    this.data = {
      version: JsonStore.CURRENT_VERSION,
      bindingCodes: {},
      userBindings: {},
      deviceToUserMap: {},
    };
  }

  /**
   * Initialize store by loading data from disk
   */
  async initialize(): Promise<void> {
    try {
      // Ensure directory exists
      await fs.mkdir(path.dirname(this.storePath), { recursive: true });

      // Try to load existing data
      try {
        const content = await fs.readFile(this.storePath, 'utf-8');
        const rawData = JSON.parse(content);

        // Check if migration is needed
        if (!rawData.version) {
          await this.migrateFromLegacy(rawData);
        } else {
          this.data = rawData;
        }

        // Clean up expired binding codes on startup
        this.cleanupExpiredBindingCodes();
      } catch (error: any) {
        // File doesn't exist or is invalid, start with empty data
        if (error.code !== 'ENOENT') {
          console.warn('Failed to load bindings data, starting fresh:', error.message);
        }
        await this.save();
      }
    } catch (error) {
      console.error('Failed to initialize JSON store:', error);
      throw error;
    }
  }

  /**
   * Migrate from legacy single-device schema to multi-device schema
   */
  private async migrateFromLegacy(rawData: any): Promise<void> {
    console.log('[JsonStore] Migrating legacy binding data to multi-device schema...');

    const legacyUserBindings = (rawData.userBindings || {}) as Record<string, LegacyUserBinding>;
    const newUserBindings: Record<string, UserBinding> = {};
    const deviceToUserMap: Record<string, string> = {};
    const now = Date.now();

    for (const [openId, legacy] of Object.entries(legacyUserBindings)) {
      newUserBindings[openId] = {
        openId,
        devices: [{
          deviceId: legacy.deviceId,
          deviceName: legacy.deviceName,
          boundAt: legacy.boundAt,
          lastActiveAt: legacy.lastActiveAt,
          isActive: true,
        }],
        activeDeviceId: legacy.deviceId,
        createdAt: legacy.boundAt,
        updatedAt: now,
      };

      deviceToUserMap[legacy.deviceId] = openId;
    }

    this.data = {
      version: JsonStore.CURRENT_VERSION,
      bindingCodes: rawData.bindingCodes || {},
      userBindings: newUserBindings,
      deviceToUserMap,
    };

    await this.save();
    console.log(`[JsonStore] Migration complete. Migrated ${Object.keys(newUserBindings).length} user(s).`);
  }

  /**
   * Store binding code with expiration
   */
  async setBindingCode(code: string, bindingCode: BindingCode): Promise<void> {
    this.data.bindingCodes[code] = bindingCode;
    await this.scheduleSave();
  }

  /**
   * Get binding code
   */
  getBindingCode(code: string): BindingCode | null {
    const bindingCode = this.data.bindingCodes[code];

    if (!bindingCode) {
      return null;
    }

    // Check if expired
    if (Date.now() > bindingCode.expiresAt) {
      delete this.data.bindingCodes[code];
      this.scheduleSave();
      return null;
    }

    return bindingCode;
  }

  /**
   * Delete binding code
   */
  async deleteBindingCode(code: string): Promise<void> {
    delete this.data.bindingCodes[code];
    await this.scheduleSave();
  }

  /**
   * Set user binding
   */
  async setUserBinding(openId: string, binding: UserBinding): Promise<void> {
    this.data.userBindings[openId] = binding;
    // Rebuild deviceToUserMap entries for this user
    for (const device of binding.devices) {
      this.data.deviceToUserMap[device.deviceId] = openId;
    }
    await this.scheduleSave();
  }

  /**
   * Get user binding
   */
  getUserBinding(openId: string): UserBinding | null {
    return this.data.userBindings[openId] || null;
  }

  /**
   * Get user openId by device ID (reverse lookup)
   */
  getUserByDeviceId(deviceId: string): string | null {
    return this.data.deviceToUserMap[deviceId] || null;
  }

  /**
   * Set device-to-user mapping
   */
  async setDeviceToUserMap(deviceId: string, openId: string): Promise<void> {
    this.data.deviceToUserMap[deviceId] = openId;
    await this.scheduleSave();
  }

  /**
   * Remove device-to-user mapping
   */
  async removeDeviceToUserMap(deviceId: string): Promise<void> {
    delete this.data.deviceToUserMap[deviceId];
    await this.scheduleSave();
  }

  /**
   * Delete user binding and all associated device mappings
   */
  async deleteUserBinding(openId: string): Promise<void> {
    const binding = this.data.userBindings[openId];
    if (binding) {
      // Remove all device-to-user mappings
      for (const device of binding.devices) {
        delete this.data.deviceToUserMap[device.deviceId];
      }
      delete this.data.userBindings[openId];
      await this.scheduleSave();
    }
  }

  /**
   * Update last active time for the active device of a user
   */
  async updateLastActive(openId: string): Promise<void> {
    const binding = this.data.userBindings[openId];
    if (binding && binding.activeDeviceId) {
      const device = binding.devices.find(d => d.deviceId === binding.activeDeviceId);
      if (device) {
        device.lastActiveAt = Date.now();
        binding.updatedAt = Date.now();
        await this.scheduleSave();
      }
    }
  }

  /**
   * Clean up expired binding codes
   */
  private cleanupExpiredBindingCodes(): void {
    const now = Date.now();
    let hasChanges = false;

    for (const [code, bindingCode] of Object.entries(this.data.bindingCodes)) {
      if (now > bindingCode.expiresAt) {
        delete this.data.bindingCodes[code];
        hasChanges = true;
      }
    }

    if (hasChanges) {
      this.scheduleSave();
    }
  }

  /**
   * Schedule a save operation (debounced).
   * All callers share the same pending save — when the timer fires and the
   * write completes, every awaiting caller is resolved at once.
   */
  private async scheduleSave(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }

    return new Promise((resolve) => {
      this.pendingResolvers.push(resolve);
      this.saveTimer = setTimeout(async () => {
        this.saveTimer = null;
        await this.save();
        const resolvers = this.pendingResolvers.splice(0);
        for (const r of resolvers) r();
      }, this.SAVE_DELAY);
    });
  }

  /**
   * Save data to disk
   */
  private async save(): Promise<void> {
    try {
      const content = JSON.stringify(this.data, null, 2);
      await fs.writeFile(this.storePath, content, 'utf-8');
    } catch (error) {
      console.error('Failed to save bindings data:', error);
    }
  }

  /**
   * Force immediate save (for graceful shutdown)
   */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.save();
  }

  /**
   * Clear all data
   */
  async clear(): Promise<void> {
    this.data = {
      version: JsonStore.CURRENT_VERSION,
      bindingCodes: {},
      userBindings: {},
      deviceToUserMap: {},
    };
    await this.save();
  }

  /**
   * Get statistics
   */
  getStats(): {
    bindingCodes: number;
    userBindings: number;
    devices: number;
  } {
    return {
      bindingCodes: Object.keys(this.data.bindingCodes).length,
      userBindings: Object.keys(this.data.userBindings).length,
      devices: Object.keys(this.data.deviceToUserMap).length,
    };
  }
}
