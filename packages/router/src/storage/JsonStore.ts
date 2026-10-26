import { BindingCode, DeviceBinding, UserBinding, LegacyUserBinding } from '../types';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';

interface StoreData {
  version: number;
  bindingCodes: Record<string, BindingCode>;
  userBindings: Record<string, UserBinding>;
  deviceToUserMap: Record<string, string>;
}

interface LegacyStoreData {
  bindingCodes: Record<string, BindingCode>;
  userBindings: Record<string, LegacyUserBinding>;
}

type ParsedStoreData = { kind: 'current'; data: StoreData } | { kind: 'legacy'; data: LegacyStoreData };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isDictionary<T>(value: unknown, entry: (value: unknown) => value is T): value is Record<string, T> {
  return isRecord(value) && Object.values(value).every(entry);
}

function isBindingCode(value: unknown): value is BindingCode {
  return isRecord(value) && isIdentifier(value.code) && isIdentifier(value.deviceId)
    && isTimestamp(value.createdAt) && isTimestamp(value.expiresAt)
    && (!Object.hasOwn(value, 'devicePublicKey') || isIdentifier(value.devicePublicKey));
}

function isLegacyBinding(value: unknown): value is LegacyUserBinding {
  return isRecord(value) && isIdentifier(value.openId) && isIdentifier(value.deviceId)
    && typeof value.deviceName === 'string' && isTimestamp(value.boundAt) && isTimestamp(value.lastActiveAt)
    && !Object.hasOwn(value, 'devices');
}

function isDeviceBinding(value: unknown): value is DeviceBinding {
  return isRecord(value) && isIdentifier(value.deviceId) && typeof value.deviceName === 'string'
    && isTimestamp(value.boundAt) && isTimestamp(value.lastActiveAt) && typeof value.isActive === 'boolean';
}

function isUserBinding(value: unknown): value is UserBinding {
  return isRecord(value) && isIdentifier(value.openId) && Array.isArray(value.devices)
    && value.devices.every(isDeviceBinding) && (value.activeDeviceId === null || isIdentifier(value.activeDeviceId))
    && isTimestamp(value.createdAt) && isTimestamp(value.updatedAt);
}

function parseStoreData(content: string, currentVersion: number): ParsedStoreData {
  const value: unknown = JSON.parse(content);
  if (isRecord(value) && value.version === currentVersion
    && isDictionary(value.bindingCodes, isBindingCode) && isDictionary(value.userBindings, isUserBinding)
    && isDictionary(value.deviceToUserMap, isIdentifier)) {
    return { kind: 'current', data: value as unknown as StoreData };
  }
  if (isRecord(value) && !Object.hasOwn(value, 'version')
    && isDictionary(value.bindingCodes, isBindingCode) && isDictionary(value.userBindings, isLegacyBinding)
    && (!Object.hasOwn(value, 'deviceBindings') || isDictionary(value.deviceBindings, isLegacyBinding))
    && (!Object.hasOwn(value, 'deviceToUserMap') || isDictionary(value.deviceToUserMap, isIdentifier))) {
    return { kind: 'legacy', data: value as unknown as LegacyStoreData };
  }
  throw new Error('Unsupported bindings data structure or version.');
}

type Draft = (current: StoreData) => StoreData | undefined;

export type DeviceThreadSelection =
  | { status: 'none' }
  | { status: 'valid'; threadId: string }
  | { status: 'invalid' };

interface PendingSave {
  createDraft: Draft;
  resolve: () => void;
  reject: (error: unknown) => void;
}

class ReplacementUncertainty extends Error {
  constructor(cause: unknown) {
    super('Bindings replacement completed, but durability could not be confirmed.', { cause });
  }
}

/** JSON file-based storage with serialized, durable-before-visible mutations. */
export class JsonStore {
  private storePath: string;
  private data: StoreData;
  private saveTimer: NodeJS.Timeout | null = null;
  private pendingSaves: PendingSave[] = [];
  private writeTail: Promise<void> = Promise.resolve();
  private draining?: Promise<void>;
  private uncertainty?: Error;
  private invalidDataError?: Error;
  private readonly expiringCodes = new Set<string>();
  private readonly SAVE_DELAY: number;
  private static readonly CURRENT_VERSION = 1;

  constructor(storePath?: string, saveDelay = 1000) {
    this.storePath = storePath || path.join(os.homedir(), '.remote-cli-router', 'bindings.json');
    this.SAVE_DELAY = saveDelay;
    this.data = this.emptyData();
  }

  private emptyData(): StoreData {
    return { version: JsonStore.CURRENT_VERSION, bindingCodes: {}, userBindings: {}, deviceToUserMap: {} };
  }

  private assertReconciled(): void {
    if (this.uncertainty) throw this.uncertainty;
    if (this.invalidDataError) throw this.invalidDataError;
  }

  /** Initialize without replacing an unreadable or damaged existing file. */
  async initialize(): Promise<void> {
    this.assertReconciled();
    await fs.mkdir(path.dirname(this.storePath), { recursive: true });
    let content: string;
    try {
      content = await fs.readFile(this.storePath, 'utf-8');
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      await this.commitImmediate(current => current);
      return;
    }

    let parsed: ParsedStoreData;
    try {
      parsed = parseStoreData(content, JsonStore.CURRENT_VERSION);
    } catch {
      // Parser diagnostics can quote private values from the original input.
      this.invalidDataError = new Error(
        'Bindings data is invalid or unsupported; the existing file was preserved. Correct or restore the file and restart the Router.',
      );
      throw this.invalidDataError;
    }
    if (parsed.kind === 'legacy') await this.migrateFromLegacy(parsed.data);
    else this.data = parsed.data;
    await this.commitImmediate(current => this.withoutExpiredBindingCodes(current));
  }

  private async migrateFromLegacy(rawData: LegacyStoreData): Promise<void> {
    console.log('[JsonStore] Migrating legacy binding data to multi-device schema...');
    const legacyUserBindings = rawData.userBindings;
    const newUserBindings: Record<string, UserBinding> = Object.create(null);
    const deviceToUserMap: Record<string, string> = Object.create(null);
    const now = Date.now();

    for (const [openId, legacy] of Object.entries(legacyUserBindings)) {
      newUserBindings[openId] = {
        openId,
        devices: [{
          deviceId: legacy.deviceId, deviceName: legacy.deviceName, boundAt: legacy.boundAt,
          lastActiveAt: legacy.lastActiveAt, isActive: true,
        }],
        activeDeviceId: legacy.deviceId, createdAt: legacy.boundAt, updatedAt: now,
      };
      deviceToUserMap[legacy.deviceId] = openId;
    }
    const migrated: StoreData = {
      version: JsonStore.CURRENT_VERSION,
      bindingCodes: { ...rawData.bindingCodes },
      userBindings: newUserBindings,
      deviceToUserMap,
    };
    await this.commitImmediate(() => migrated);
    console.log(`[JsonStore] Migration complete. Migrated ${Object.keys(newUserBindings).length} user(s).`);
  }

  async setBindingCode(code: string, bindingCode: BindingCode): Promise<void> {
    const copy = { ...bindingCode };
    await this.scheduleSave(current => ({ ...current, bindingCodes: { ...current.bindingCodes, [code]: copy } }));
  }

  getBindingCode(code: string): BindingCode | null {
    this.assertReconciled();
    const bindingCode = this.data.bindingCodes[code];
    if (!bindingCode) return null;
    if (Date.now() > bindingCode.expiresAt) {
      this.scheduleExpiry(code);
      return null;
    }
    return { ...bindingCode };
  }

  private scheduleExpiry(code: string): void {
    if (this.expiringCodes.has(code)) return;
    this.expiringCodes.add(code);
    const operation = this.scheduleSave(current => {
      const candidate = current.bindingCodes[code];
      if (!candidate || Date.now() <= candidate.expiresAt) return undefined;
      const bindingCodes = { ...current.bindingCodes };
      delete bindingCodes[code];
      return { ...current, bindingCodes };
    });
    const settled = () => { this.expiringCodes.delete(code); };
    void operation.then(settled, settled);
    this.reportBackgroundSave(operation);
  }

  async deleteBindingCode(code: string): Promise<void> {
    await this.scheduleSave(current => {
      if (!current.bindingCodes[code]) return undefined;
      const bindingCodes = { ...current.bindingCodes };
      delete bindingCodes[code];
      return { ...current, bindingCodes };
    });
  }

  async setUserBinding(openId: string, binding: UserBinding): Promise<void> {
    const copy: UserBinding = { ...binding, devices: binding.devices.map(device => ({ ...device })) };
    await this.scheduleSave(current => {
      const deviceToUserMap = { ...current.deviceToUserMap };
      for (const device of copy.devices) deviceToUserMap[device.deviceId] = openId;
      return { ...current, userBindings: { ...current.userBindings, [openId]: copy }, deviceToUserMap };
    });
  }

  getUserBinding(openId: string): UserBinding | null {
    this.assertReconciled();
    const binding = this.data.userBindings[openId];
    return binding ? { ...binding, devices: binding.devices.map(device => ({ ...device })) } : null;
  }

  getDeviceThreadSelection(openId: string, deviceId: string): DeviceThreadSelection {
    this.assertReconciled();
    const device = this.data.userBindings[openId]?.devices.find(item => item.deviceId === deviceId);
    if (!device || !Object.hasOwn(device, 'selectedThreadId')) return { status: 'none' };
    const value = (device as { selectedThreadId?: unknown }).selectedThreadId;
    return typeof value === 'string' && value.length > 0 && value.length <= 200
      ? { status: 'valid', threadId: value }
      : { status: 'invalid' };
  }

  /** Prompt, FIFO preference mutation against the latest committed binding state. */
  async setDeviceThreadSelection(openId: string, deviceId: string, threadId: string | null,
    options: { expectedThreadId?: string; requireActive?: boolean; guard?: () => boolean } = {}): Promise<boolean> {
    if (threadId !== null && (typeof threadId !== 'string' || threadId.length === 0 || threadId.length > 200)) {
      throw new Error('Invalid selected thread ID.');
    }
    let matches = true;
    await this.commitQueued(current => {
      if (options.guard && !options.guard()) {
        matches = false;
        return undefined;
      }
      const binding = current.userBindings[openId];
      const device = binding?.devices.find(item => item.deviceId === deviceId);
      if (!binding || !device) throw new Error('Device is no longer bound to this user.');
      if ((options.requireActive && binding.activeDeviceId !== deviceId)
        || (options.expectedThreadId !== undefined && device.selectedThreadId !== options.expectedThreadId)) {
        matches = false;
        return undefined;
      }
      if (device.selectedThreadId === threadId
        || (threadId === null && !Object.hasOwn(device, 'selectedThreadId'))) return undefined;
      const devices = binding.devices.map(item => {
        if (item.deviceId !== deviceId) return { ...item };
        if (threadId !== null) return { ...item, selectedThreadId: threadId };
        const { selectedThreadId: _removed, ...withoutSelection } = item;
        return withoutSelection;
      });
      return { ...current, userBindings: { ...current.userBindings,
        [openId]: { ...binding, devices, updatedAt: Date.now() } } };
    });
    return matches;
  }

  listBoundUserIds(): string[] {
    this.assertReconciled();
    return Object.keys(this.data.userBindings).filter(id => this.data.userBindings[id].devices.length > 0);
  }

  getUserByDeviceId(deviceId: string): string | null {
    this.assertReconciled();
    return this.data.deviceToUserMap[deviceId] || null;
  }

  async setDeviceToUserMap(deviceId: string, openId: string): Promise<void> {
    await this.scheduleSave(current => ({ ...current,
      deviceToUserMap: { ...current.deviceToUserMap, [deviceId]: openId } }));
  }

  async removeDeviceToUserMap(deviceId: string): Promise<void> {
    await this.scheduleSave(current => {
      if (!current.deviceToUserMap[deviceId]) return undefined;
      const deviceToUserMap = { ...current.deviceToUserMap };
      delete deviceToUserMap[deviceId];
      return { ...current, deviceToUserMap };
    });
  }

  /** Remove both ownership representations and select any replacement active device in one snapshot. */
  async unbindDevice(openId: string, deviceId: string): Promise<boolean> {
    let removed = false;
    await this.scheduleSave(current => {
      const binding = current.userBindings[openId];
      const deviceIndex = binding?.devices.findIndex(device => device.deviceId === deviceId) ?? -1;
      if (!binding || deviceIndex < 0) return undefined;
      const devices = binding.devices.filter(device => device.deviceId !== deviceId).map(device => ({ ...device }));
      const deviceToUserMap = { ...current.deviceToUserMap };
      if (deviceToUserMap[deviceId] === openId) delete deviceToUserMap[deviceId];
      const userBindings = { ...current.userBindings };
      if (devices.length === 0) delete userBindings[openId];
      else {
        let activeDeviceId = binding.activeDeviceId;
        if (activeDeviceId === deviceId) {
          devices[0] = { ...devices[0], isActive: true };
          activeDeviceId = devices[0].deviceId;
        }
        userBindings[openId] = { ...binding, devices, activeDeviceId, updatedAt: Date.now() };
      }
      removed = true;
      return { ...current, userBindings, deviceToUserMap };
    });
    return removed;
  }

  async deleteUserBinding(openId: string): Promise<void> {
    await this.scheduleSave(current => {
      const binding = current.userBindings[openId];
      if (!binding) return undefined;
      const deviceToUserMap = { ...current.deviceToUserMap };
      for (const device of binding.devices) {
        if (deviceToUserMap[device.deviceId] === openId) delete deviceToUserMap[device.deviceId];
      }
      const userBindings = { ...current.userBindings };
      delete userBindings[openId];
      return { ...current, userBindings, deviceToUserMap };
    });
  }

  async updateLastActive(openId: string): Promise<void> {
    const now = Date.now();
    await this.scheduleSave(current => {
      const binding = current.userBindings[openId];
      if (!binding?.activeDeviceId) return undefined;
      const device = binding.devices.find(item => item.deviceId === binding.activeDeviceId);
      if (!device) return undefined;
      const updated: UserBinding = { ...binding, updatedAt: now,
        devices: binding.devices.map(item => item.deviceId === device.deviceId ? { ...item, lastActiveAt: now } : { ...item }) };
      return { ...current, userBindings: { ...current.userBindings, [openId]: updated } };
    });
  }

  private withoutExpiredBindingCodes(current: StoreData): StoreData | undefined {
    const now = Date.now();
    const bindingCodes = { ...current.bindingCodes };
    let changed = false;
    for (const [code, bindingCode] of Object.entries(bindingCodes)) {
      if (now > bindingCode.expiresAt) {
        delete bindingCodes[code];
        changed = true;
      }
    }
    return changed ? { ...current, bindingCodes } : undefined;
  }

  /** Capture inputs at admission, but compute drafts only against prior committed state. */
  private scheduleSave(createDraft: Draft): Promise<void> {
    if (this.invalidDataError) return Promise.reject(this.invalidDataError);
    return new Promise<void>((resolve, reject) => {
      this.pendingSaves.push({ createDraft, resolve, reject });
      if (this.saveTimer) clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        this.reportBackgroundSave(this.drainSaves());
      }, this.SAVE_DELAY);
    });
  }

  private reportBackgroundSave(operation: Promise<void>): void {
    void operation.catch(error => console.error('Failed to save bindings data:', error));
  }

  private drainSaves(): Promise<void> {
    if (this.draining) return this.draining;
    const draining = (async () => {
      const errors: unknown[] = [];
      while (this.pendingSaves.length > 0) {
        const writes = this.admitPendingSaves();
        const results = await Promise.allSettled(writes);
        for (const result of results) if (result.status === 'rejected') errors.push(result.reason);
      }
      await this.writeTail;
      if (errors.length > 0) throw errors[0];
    })();
    this.draining = draining;
    const clear = () => { if (this.draining === draining) this.draining = undefined; };
    void draining.then(clear, clear);
    return draining;
  }

  /** Move admitted debounced writes into the shared FIFO before an immediate write. */
  private admitPendingSaves(): Promise<void>[] {
    const batch = this.pendingSaves.splice(0);
    return batch.map(request => {
      const write = this.enqueueWrite(request.createDraft);
      void write.then(request.resolve, request.reject);
      return write;
    });
  }

  private commitImmediate(createDraft: Draft): Promise<void> {
    return this.enqueueWrite(createDraft);
  }

  private commitQueued(createDraft: Draft): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.admitPendingSaves();
    return this.enqueueWrite(createDraft);
  }

  private enqueueWrite(createDraft: Draft): Promise<void> {
    const write = this.writeTail.then(async () => {
      this.assertReconciled();
      const draft = createDraft(this.data);
      if (!draft) return;
      try {
        await this.writeSnapshot(draft);
      } catch (error) {
        if (error instanceof ReplacementUncertainty) {
          this.uncertainty = new Error(
            'Bindings disk state is uncertain after replacement. Authentication and writes are blocked until a new JsonStore reconciles the file.',
            { cause: error },
          );
          throw this.uncertainty;
        }
        throw error;
      }
      // Publication is authoritative only after replacement and required fsyncs succeed.
      this.data = draft;
    });
    this.writeTail = write.catch(() => undefined);
    return write;
  }

  /** Atomically replace the file, distinguishing pre-replacement and uncertain failures. */
  private async writeSnapshot(snapshot: StoreData): Promise<void> {
    const temporary = `${this.storePath}.${randomUUID()}.tmp`;
    let handle: fs.FileHandle | undefined;
    let replaced = false;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(snapshot, null, 2), 'utf-8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporary, this.storePath);
      replaced = true;
      // Windows does not support directory handles/fsync through this portable path.
      if (process.platform !== 'win32') {
        const directory = await fs.open(path.dirname(this.storePath), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } catch (error) {
      if (replaced) throw new ReplacementUncertainty(error);
      throw error;
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  /** Drain accepted writes, including writes admitted while an earlier flush waits. */
  async flush(): Promise<void> {
    const blocked = this.uncertainty ?? this.invalidDataError;
    const errors: unknown[] = blocked ? [blocked] : [];
    do {
      if (this.saveTimer) {
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
      }
      try { await this.drainSaves(); } catch (error) { errors.push(error); }
    } while (this.saveTimer || this.pendingSaves.length > 0);
    if (errors.length > 0) throw errors[0];
  }

  async clear(): Promise<void> {
    await this.scheduleSave(() => this.emptyData());
  }

  getStats(): { bindingCodes: number; userBindings: number; devices: number } {
    this.assertReconciled();
    return {
      bindingCodes: Object.keys(this.data.bindingCodes).length,
      userBindings: Object.keys(this.data.userBindings).length,
      devices: Object.keys(this.data.deviceToUserMap).length,
    };
  }
}
