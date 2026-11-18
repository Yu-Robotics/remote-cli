import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import http from 'http';
import { AgyHookRelay, installAgyScheduleHooks } from '../../src/scheduling/agy/AgyHookRelay';
import { relayHook } from '../../src/scheduling/agy/hookClient';

vi.mock('../../src/delegation/OwnershipRuntime', async load => {
  const actual = await load<typeof import('../../src/delegation/OwnershipRuntime')>();
  const { syntheticOwnershipRuntime } = await import('../delegation/syntheticOwnershipRuntime');
  return syntheticOwnershipRuntime(actual);
});

describe('private AGY event relay and hook overlay', () => {
  let home: string; let relay: AgyHookRelay; let descriptor: { url: string; token: string };
  let target: string; let descriptorFile: string;
  const accept = vi.fn(() => ({ decision: 'allow' as const })); const fault = vi.fn();
  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agy-relay-')));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    target = path.join(home, '.gemini', 'antigravity-cli', 'brain', 'synthetic-session', '.system_generated', 'logs', 'transcript_full.jsonl');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, JSON.stringify({ step_index: 0, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Synthetic result' }) + '\n');
    relay = new AgyHookRelay(home, accept, fault); descriptor = await relay.start(); relay.bindSession('synthetic-session');
    descriptorFile = path.join(home, 'relay.json'); await fs.writeFile(descriptorFile, JSON.stringify(descriptor));
  });
  afterEach(async () => { await relay.close(); vi.restoreAllMocks(); accept.mockClear(); fault.mockClear(); await fs.rm(home, { recursive: true, force: true }); });
  const payload = (locator: string, session = 'synthetic-session') => JSON.stringify({ conversationId: session, transcriptPath: locator });

  it('reads only on an authenticated callback and returns the actual decision', async () => {
    expect(accept).not.toHaveBeenCalled();
    expect(await relayHook(descriptorFile, 'PreToolUse', payload(target))).toEqual({ decision: 'allow' });
    expect(accept).toHaveBeenCalledWith('PreToolUse', expect.any(Object), [expect.objectContaining({ content: 'Synthetic result' })]);
    expect(fault).not.toHaveBeenCalled();
  });
  it('requires the exact transcript observed at the terminal for clean host retirement', async () => {
    const records = [JSON.parse(await fs.readFile(target, 'utf8'))];
    await expect(relay.confirmsTerminal(records)).resolves.toBe(true);
    await fs.appendFile(target, JSON.stringify({ ...records[0], step_index: 1 }) + '\n');
    await expect(relay.confirmsTerminal(records)).resolves.toBe(false);
    await fs.unlink(target);
    await expect(relay.confirmsTerminal(records)).resolves.toBe(false);
  });
  it('rejects an unauthenticated caller without reading a transcript or fencing the owner', async () => {
    const status = await new Promise(resolve => {
      const request = http.request(descriptor.url, { method: 'POST' }, response => { response.resume(); resolve(response.statusCode); });
      request.end('{}');
    });
    expect(status).toBe(403); expect(accept).not.toHaveBeenCalled(); expect(fault).not.toHaveBeenCalled();
  });
  it('refuses cross-session/outside locators and returns deny on relay errors', async () => {
    expect(await relayHook(descriptorFile, 'PreInvocation', payload(target, 'other-session'))).toEqual({ terminationBehavior: 'terminate' });
    expect(await relayHook(descriptorFile, 'PreToolUse', payload(descriptorFile))).toMatchObject({ decision: 'deny' });
    expect(fault).toHaveBeenCalledTimes(2); expect(accept).not.toHaveBeenCalled();
    expect(() => relay.bindSession('other')).toThrow('rebound');
  });
  it('rejects a symlink locator even to another synthetic file inside its HOME', async () => {
    await fs.unlink(target);
    try { await fs.symlink(descriptorFile, target); }
    catch (error) {
      // Windows without Developer Mode can deny symlink creation. Ordinary
      // canonical path/size/auth tests above still run on that platform.
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    expect(await relayHook(descriptorFile, 'PreInvocation', payload(target))).toEqual({ terminationBehavior: 'terminate' });
    expect(fault).toHaveBeenCalledOnce(); expect(accept).not.toHaveBeenCalled();
  });
  it('fails on oversized or partially written native transcript rather than guessing a terminal', async () => {
    await fs.writeFile(target, '{"step_index":');
    await relayHook(descriptorFile, 'Stop', payload(target)); expect(fault).toHaveBeenCalledOnce();
    await fs.truncate(target, 8 * 1024 * 1024 + 1);
    await relayHook(descriptorFile, 'Stop', payload(target)); expect(fault).toHaveBeenCalledTimes(2);
  });
  it('merges user hook groups and restores their exact text without overwriting concurrent edits', async () => {
    const config = path.join(home, '.gemini', 'config', 'hooks.json');
    await fs.mkdir(path.dirname(config), { recursive: true });
    const original = '{\n "user-hooks": {"enabled": true, "Stop": []}\n}\n'; await fs.writeFile(config, original);
    const restore = await installAgyScheduleHooks(home, descriptor);
    const installed = await fs.readFile(config, 'utf8');
    const groups = JSON.parse(installed); expect(groups['user-hooks']).toEqual(JSON.parse(original)['user-hooks']);
    expect(groups['remote-cli-native-schedule'].PreToolUse[0].matcher).toBe('.*');
    expect(installed).not.toContain(descriptor.token);
    await restore(); expect(await fs.readFile(config, 'utf8')).toBe(original);
    const edited = await installAgyScheduleHooks(home, descriptor);
    const withEdit = JSON.parse(await fs.readFile(config, 'utf8')); withEdit['new-user-group'] = { enabled: false };
    await fs.writeFile(config, JSON.stringify(withEdit)); await edited();
    expect(JSON.parse(await fs.readFile(config, 'utf8'))).toEqual({ ...JSON.parse(original), 'new-user-group': { enabled: false } });
  });
  it('detaches private HOME config links and restores them without changing the shared target', async () => {
    const shared = path.join(home, 'synthetic-shared-config'); await fs.mkdir(shared);
    await fs.writeFile(path.join(shared, 'hooks.json'), '{}');
    try { await fs.symlink(shared, path.join(home, '.gemini', 'config'), 'dir'); }
    catch (error) { if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') return; throw error; }
    const restore = await installAgyScheduleHooks(home, descriptor);
    expect((await fs.lstat(path.join(home, '.gemini', 'config'))).isSymbolicLink()).toBe(false);
    await restore();
    expect((await fs.lstat(path.join(home, '.gemini', 'config'))).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(shared, 'hooks.json'), 'utf8')).toBe('{}');
  });
  it('refuses non-loopback descriptors and returns supported failure decisions without a network call', async () => {
    await fs.writeFile(descriptorFile, JSON.stringify({ ...descriptor, url: 'https://example.com/hook' }));
    expect(await relayHook(descriptorFile, 'PreToolUse', '{}')).toMatchObject({ decision: 'deny' });
    expect(await relayHook(descriptorFile, 'PreInvocation', '{}')).toEqual({ terminationBehavior: 'terminate' });
    expect(await relayHook(descriptorFile, 'Stop', '{}')).toEqual({});
  });
});
