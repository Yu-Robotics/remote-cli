import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { AutomaticFileEnrollment } from '../../src/files/AutomaticFileEnrollment';
import { loadIdentity } from '../../src/files/DeviceIdentity';
import { verify } from 'crypto';

describe('automatic file enrollment key preparation', () => {
  let root: string;
  const url = 'https://router.example.com';
  beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'auto-files-cli-'))); });
  afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

  it.each([
    [url, false, true], [url, true, false], ['http://router.example.com', true, true],
    ['https://user:secret@router.example.com', true, true], ['not-a-url', true, true],
  ])('does not prepare an identity for ineligible or opted-out configuration %s', async (server, eligible, enabled) => {
    const enrollment = new AutomaticFileEnrollment(root, server as string, 'device', enabled as boolean);
    expect(await enrollment.prepare(eligible as boolean)).toBeUndefined();
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('coalesces preparation, durably reuses a key across restart, and sends no private key', async () => {
    const enrollment = new AutomaticFileEnrollment(root, url, 'device');
    const first = enrollment.prepare(true);
    expect(enrollment.prepare(true)).toBe(first);
    const key = (await first)!;
    expect(await loadIdentity(root, url, 'device')).toEqual(key);
    // A new connection may retry a lost request with exactly the persisted key.
    expect(await enrollment.prepare(true)).toEqual(key);
    const resumed = await new AutomaticFileEnrollment(root, url, 'device').prepare(true);
    expect(resumed).toEqual(key);
    const proof = AutomaticFileEnrollment.proof(key, 'device');
    expect(verify(null, Buffer.from(`remote-cli-device-v1\ndevice\n${proof.nonce}`), proof.publicKey,
      Buffer.from(proof.signature, 'base64'))).toBe(true);
    expect(JSON.stringify(proof)).not.toContain(key.privateKey);
  });

  it('supports loopback HTTP but never replaces a malformed saved identity', async () => {
    const server = 'http://127.0.0.1:3000';
    const first = new AutomaticFileEnrollment(root, server, 'device');
    expect(await first.prepare(true)).toBeDefined();
    const folder = path.join(root, 'device-identities');
    const filename = path.join(folder, (await fs.readdir(folder))[0]);
    await fs.writeFile(filename, '{"invalid":true}');
    expect(await new AutomaticFileEnrollment(root, server, 'device').prepare(true)).toBeUndefined();
    expect(await fs.readFile(filename, 'utf8')).toBe('{"invalid":true}');
  });

  it('keeps identity storage failures independent of text operation and permits a later connection to retry', async () => {
    const enrollment = new AutomaticFileEnrollment(root, url, 'device');
    vi.spyOn(fs, 'mkdir').mockRejectedValueOnce(new Error('synthetic failure'));
    expect(await enrollment.prepare(true)).toBeUndefined();
    expect(await enrollment.prepare(true)).toBeDefined();
  });
});
