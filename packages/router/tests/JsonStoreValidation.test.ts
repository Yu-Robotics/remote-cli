import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { inspect } from 'util';
import { JsonStore } from '../src/storage/JsonStore';

function currentData() {
  return {
    version: 1,
    bindingCodes: {
      'test-code': { code: 'test-code', deviceId: 'device-a', createdAt: 0, expiresAt: 9_000_000_000_000 },
    },
    userBindings: {
      'user-a': {
        openId: 'user-a',
        devices: [{ deviceId: 'device-a', deviceName: '', boundAt: 0, lastActiveAt: 0, isActive: true }],
        activeDeviceId: 'device-a', createdAt: 0, updatedAt: 0,
      },
    },
    deviceToUserMap: { 'device-a': 'user-a' },
  };
}

function legacyData() {
  const binding = { openId: 'user-a', deviceId: 'device-a', deviceName: 'Test device', boundAt: 0, lastActiveAt: 0 };
  return { bindingCodes: currentData().bindingCodes, userBindings: { 'user-a': binding }, deviceBindings: { 'device-a': binding } };
}

describe('JsonStore input validation', () => {
  let directory: string;
  let storePath: string;

  beforeEach(async () => {
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'remote-cli-binding-validation-')));
    storePath = path.join(directory, 'bindings.json');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  const invalidRoots = [
    ['null', 'null'], ['array', '[]'], ['string', '"synthetic-private-marker"'],
    ['number', '42'], ['boolean', 'false'], ['empty object', '{}'],
    ['unrelated object', '{"other":{}}'], ['missing codes', '{"userBindings":{}}'],
    ['missing users', '{"bindingCodes":{}}'], ['invalid JSON', '{'],
  ];

  it.each(invalidRoots)('preserves an invalid %s without publishing empty bindings', async (_name, input) => {
    const original = Buffer.from(` \r\n${input}\n `);
    await fs.writeFile(storePath, original);
    const store = new JsonStore(storePath, 0);
    const rename = vi.spyOn(fs, 'rename');
    await expect(store.initialize()).rejects.toThrow(/invalid|unsupported/i);
    expect(rename).not.toHaveBeenCalled();
    expect(await fs.readFile(storePath)).toEqual(original);
    expect(() => store.getStats()).toThrow(/invalid|unsupported/i);
    expect(() => store.getUserByDeviceId('device-a')).toThrow(/invalid|unsupported/i);
    await expect(store.clear()).rejects.toThrow(/invalid|unsupported/i);
    await expect(store.setDeviceToUserMap('device-a', 'user-a')).rejects.toThrow(/invalid|unsupported/i);
    await expect(store.flush()).rejects.toThrow(/invalid|unsupported/i);
    expect(rename).not.toHaveBeenCalled();
    expect(await fs.readFile(storePath)).toEqual(original);
  });

  const invalidRecords: Array<[string, (data: any) => void]> = [
    ['null version', data => { data.version = null; }],
    ['zero version', data => { data.version = 0; }],
    ['string version', data => { data.version = '1'; }],
    ['future version', data => { data.version = 2; }],
    ['missing code collection', data => { delete data.bindingCodes; }],
    ['code collection array', data => { data.bindingCodes = []; }],
    ['null code entry', data => { data.bindingCodes['test-code'] = null; }],
    ['array code entry', data => { data.bindingCodes['test-code'] = []; }],
    ['invalid code identity', data => { data.bindingCodes['test-code'].deviceId = ''; }],
    ['missing code value', data => { delete data.bindingCodes['test-code'].code; }],
    ['invalid code timestamp', data => { data.bindingCodes['test-code'].createdAt = '0'; }],
    ['missing code expiry', data => { delete data.bindingCodes['test-code'].expiresAt; }],
    ['invalid public key', data => { data.bindingCodes['test-code'].devicePublicKey = false; }],
    ['empty public key', data => { data.bindingCodes['test-code'].devicePublicKey = ''; }],
    ['missing users collection', data => { delete data.userBindings; }],
    ['null user collection', data => { data.userBindings = null; }],
    ['null user entry', data => { data.userBindings['user-a'] = null; }],
    ['missing user identity', data => { delete data.userBindings['user-a'].openId; }],
    ['missing devices', data => { delete data.userBindings['user-a'].devices; }],
    ['object devices', data => { data.userBindings['user-a'].devices = {}; }],
    ['null device', data => { data.userBindings['user-a'].devices = [null]; }],
    ['missing device name', data => { delete data.userBindings['user-a'].devices[0].deviceName; }],
    ['invalid device identity', data => { data.userBindings['user-a'].devices[0].deviceId = 7; }],
    ['invalid device time', data => { data.userBindings['user-a'].devices[0].boundAt = null; }],
    ['missing device activity time', data => { delete data.userBindings['user-a'].devices[0].lastActiveAt; }],
    ['invalid active flag', data => { data.userBindings['user-a'].devices[0].isActive = 'true'; }],
    ['missing active device', data => { delete data.userBindings['user-a'].activeDeviceId; }],
    ['invalid active device', data => { data.userBindings['user-a'].activeDeviceId = false; }],
    ['invalid user creation time', data => { data.userBindings['user-a'].createdAt = '0'; }],
    ['missing user update time', data => { delete data.userBindings['user-a'].updatedAt; }],
    ['missing device index', data => { delete data.deviceToUserMap; }],
    ['invalid device index', data => { data.deviceToUserMap = []; }],
    ['invalid indexed user', data => { data.deviceToUserMap['device-a'] = {}; }],
  ];

  it.each(invalidRecords)('preserves current data with %s', async (_name, corrupt) => {
    const data = currentData();
    corrupt(data);
    const original = JSON.stringify(data, null, 2);
    await fs.writeFile(storePath, original);
    await expect(new JsonStore(storePath, 0).initialize()).rejects.toThrow(/invalid|unsupported/i);
    expect(await fs.readFile(storePath, 'utf8')).toBe(original);
  });

  it('rejects non-finite JSON numbers before removing expired codes', async () => {
    const data = currentData();
    data.bindingCodes['test-code'].expiresAt = -1;
    const original = JSON.stringify(data).replace('"updatedAt":0', '"updatedAt":1e999');
    await fs.writeFile(storePath, original);
    await expect(new JsonStore(storePath, 0).initialize()).rejects.toThrow(/invalid|unsupported/i);
    expect(await fs.readFile(storePath, 'utf8')).toBe(original);
  });

  it('keeps parser diagnostics from quoting private input in error logs', async () => {
    const marker = 'SYNTHETIC';
    await fs.writeFile(storePath, marker);
    const error = await new JsonStore(storePath, 0).initialize().catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(inspect(error, { depth: 5 })).not.toContain(marker);
    expect(await fs.readFile(storePath, 'utf8')).toBe(marker);
  });

  it.each([
    ['invalid legacy collection', (data: any) => { data.userBindings = []; }],
    ['invalid legacy entry', (data: any) => { data.userBindings['user-a'] = null; }],
    ['missing legacy device', (data: any) => { delete data.userBindings['user-a'].deviceId; }],
    ['invalid legacy time', (data: any) => { data.userBindings['user-a'].lastActiveAt = false; }],
    ['invalid legacy device index', (data: any) => { data.deviceBindings = []; }],
    ['invalid legacy indexed record', (data: any) => { data.deviceBindings['device-a'] = null; }],
    ['invalid legacy user index', (data: any) => { data.deviceToUserMap = { 'device-a': null }; }],
    ['mixed legacy and current entry', (data: any) => { data.userBindings['user-a'].devices = []; }],
    ['lost current version', (data: any) => { Object.assign(data, currentData()); delete data.version; }],
  ])('preserves %s instead of partially migrating it', async (_name, corrupt) => {
    const data = legacyData();
    corrupt(data);
    const original = JSON.stringify(data, null, 2);
    await fs.writeFile(storePath, original);
    await expect(new JsonStore(storePath, 0).initialize()).rejects.toThrow(/invalid|unsupported/i);
    expect(await fs.readFile(storePath, 'utf8')).toBe(original);
  });

  it('loads supported current records and preserves optional metadata', async () => {
    const data: any = currentData();
    data.bindingCodes['test-code'].devicePublicKey = 'synthetic-public-key';
    data.userBindings['user-b'] = { openId: 'user-b', devices: [], activeDeviceId: null, createdAt: 0, updatedAt: 0 };
    data.additionalMetadata = { label: 'fixture' };
    await fs.writeFile(storePath, JSON.stringify(data));
    const store = new JsonStore(storePath, 0);
    await store.initialize();
    expect(store.getUserBinding('user-a')).toEqual(data.userBindings['user-a']);
    expect(store.getUserBinding('user-b')).toEqual(data.userBindings['user-b']);
    expect(store.getBindingCode('test-code')?.devicePublicKey).toBe('synthetic-public-key');
    expect(JSON.parse(await fs.readFile(storePath, 'utf8')).additionalMetadata).toEqual(data.additionalMetadata);
  });

  it.each([true, false])('migrates valid legacy data with redundant index present=%s', async indexed => {
    const data: any = legacyData();
    data.deviceToUserMap = { 'device-a': 'user-a' };
    if (!indexed) delete data.deviceBindings;
    await fs.writeFile(storePath, JSON.stringify(data));
    const store = new JsonStore(storePath, 0);
    await store.initialize();
    expect(store.getUserByDeviceId('device-a')).toBe('user-a');
    expect(store.getUserBinding('user-a')?.devices[0]).toMatchObject({ deviceId: 'device-a', isActive: true });
    const reopened = new JsonStore(storePath, 0);
    await reopened.initialize();
    expect(reopened.getUserBinding('user-a')).toEqual(store.getUserBinding('user-a'));
    expect(JSON.parse(await fs.readFile(storePath, 'utf8')).version).toBe(1);
  });

  it.each([
    ['__proto__', 'constructor'], ['constructor', '__proto__'],
  ])('preserves opaque legacy keys %s and %s during migration', async (openId, deviceId) => {
    const binding = { openId, deviceId, deviceName: '', boundAt: 0, lastActiveAt: 0 };
    await fs.writeFile(storePath, JSON.stringify({ bindingCodes: {}, userBindings: Object.fromEntries([[openId, binding]]) }));
    const store = new JsonStore(storePath, 0);
    await store.initialize();
    const reopened = new JsonStore(storePath, 0);
    await reopened.initialize();
    expect(reopened.getUserByDeviceId(deviceId)).toBe(openId);
    expect(reopened.getUserBinding(openId)?.devices[0].deviceId).toBe(deviceId);
  });

  it('retains support for empty legacy files and absent-file initialization', async () => {
    const store = new JsonStore(storePath, 0);
    await store.initialize();
    expect(store.getStats()).toEqual({ bindingCodes: 0, userBindings: 0, devices: 0 });
    await fs.writeFile(storePath, JSON.stringify({ bindingCodes: {}, userBindings: {} }));
    const legacy = new JsonStore(storePath, 0);
    await legacy.initialize();
    expect(legacy.getStats()).toEqual(store.getStats());
  });

  it('blocks stale reads after invalid reinitialization and permits a fresh instance after repair', async () => {
    const original = JSON.stringify(currentData());
    await fs.writeFile(storePath, original);
    const store = new JsonStore(storePath, 0);
    await store.initialize();
    await fs.writeFile(storePath, 'null');
    await expect(store.initialize()).rejects.toThrow(/invalid|unsupported/i);
    expect(() => store.getUserBinding('user-a')).toThrow(/invalid|unsupported/i);
    await fs.writeFile(storePath, original);
    const repaired = new JsonStore(storePath, 0);
    await repaired.initialize();
    expect(repaired.getUserByDeviceId('device-a')).toBe('user-a');
  });
});
