import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { JsonStore } from '../src/storage/JsonStore';
import { IngressLimitError } from '../src/security/IngressAdmission';

describe('binding state capacity before persistence', () => {
  let root: string;
  let filename: string;
  let store: JsonStore;
  const code = (deviceId: string, expiresAt = Date.now() + 300_000) => ({ code: 'synthetic', deviceId, createdAt: Date.now(), expiresAt });
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'binding-ingress-')));
    filename = path.join(root, 'bindings.json');
    store = new JsonStore(filename, 0);
    await store.initialize();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(async () => {
    await store.flush().catch(() => {});
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });
  async function seed(bindingCodes: Record<string, ReturnType<typeof code>>) {
    await fs.writeFile(filename, JSON.stringify({ version: 1, bindingCodes, userBindings: {}, deviceToUserMap: {} }));
    store = new JsonStore(filename, 0); await store.initialize();
  }
  it('retains the device cap across restart and refuses before disk replacement', async () => {
    await seed({ a: code('target'), b: code('target'), c: code('target') });
    const rename = vi.spyOn(fs, 'rename');
    await expect(store.setBindingCode('refused', code('target'))).rejects.toBeInstanceOf(IngressLimitError);
    expect(rename).not.toHaveBeenCalled();
    expect(store.getBindingCode('refused')).toBeNull();
    await store.setBindingCode('other', code('another-target'));
    expect(JSON.parse(await fs.readFile(filename, 'utf8')).bindingCodes.refused).toBeUndefined();
  });
  it('bounds global stored state from other peers after restart', async () => {
    await seed(Object.fromEntries(Array.from({ length: 4096 }, (_, i) => [`code-${i}`, code(`device-${i}`)])));
    const rename = vi.spyOn(fs, 'rename');
    await expect(store.setBindingCode('refused', code('another-target'))).rejects.toBeInstanceOf(IngressLimitError);
    expect(rename).not.toHaveBeenCalled();
    expect(store.getStats().bindingCodes).toBe(4096);
  });
  it('serializes competing writes so only three live codes for the same target persist', async () => {
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => store.setBindingCode(`code-${i}`, code('same-target'))));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(3);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(9);
    expect(store.getStats().bindingCodes).toBe(3);
  });
  it('reclaims expired state within an admitted write and preserves unrelated bindings', async () => {
    await seed(Object.fromEntries(Array.from({ length: 4096 }, (_, i) => [`code-${i}`, code('expired-target', Date.now() - 1)])));
    await store.setBindingCode('fresh', code('expired-target'));
    expect(store.getStats().bindingCodes).toBe(1);
    expect(store.getBindingCode('fresh')).not.toBeNull();
  });
});
