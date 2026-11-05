import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureHistoryTarget, type OwnedHistoryTarget } from '../../src/delegation/NativeHistoryFiles';
import { deleteOwnedKimiSession, type KimiDeletionTransport } from '../../src/delegation/KimiSessionDeletion';
import { deletionPreparation, type NativeDeletionPreparation } from '../../src/delegation/NativeSessionDeletion';

describe('Kimi deletion-only maintenance', () => {
  let home: string;
  let target: OwnedHistoryTarget;
  let client: KimiDeletionTransport;
  let prepared: NativeDeletionPreparation | undefined;
  let fence: boolean;
  let factory: ReturnType<typeof vi.fn>;
  const capabilities = () => ({ protocolVersion: 1, agentInfo: { version: '2.3.3' },
    agentCapabilities: { sessionCapabilities: { delete: {} } } });
  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'kimi-delete-')));
    vi.spyOn(os, 'homedir').mockReturnValue(home); vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home);
    const root = path.join(home, 'native'); const pointerRoot = path.join(home, 'pointers');
    await fs.mkdir(root); await fs.mkdir(pointerRoot);
    const id = randomUUID(); const lane = `delegate-lane-${randomUUID()}`; const pointer = path.join(pointerRoot, `${lane}.json`);
    await fs.writeFile(pointer, JSON.stringify({ id }));
    target = await captureHistoryTarget({ backend: 'kimi', sessionId: id, executorThreadId: lane,
      home, nativeHome: root, scope: root, cwd: home, pointer, command: 'synthetic-kimi' });
    prepared = undefined; fence = false;
    client = {
      initialize: vi.fn(async () => capabilities()), permanentDelete: vi.fn(async () => ({})),
      destroy: vi.fn(), waitForExit: vi.fn(async () => {}), waitForManagedProcessGroupExit: vi.fn(async () => {}),
    };
    factory = vi.fn(() => { expect(fence).toBe(true); return client; });
  });
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(home, { recursive: true, force: true }); });
  function remove() {
    return deleteOwnedKimiSession(target, { prepared, persistPrepared: async value => { prepared = structuredClone(value); },
      persistMaintenanceState: async value => { fence = value; } }, factory);
  }
  it('initializes and deletes the exact identity without loading a native session or authenticating', async () => {
    vi.mocked(client.permanentDelete).mockImplementation(async id => {
      expect(id).toBe(target.sessionId); expect(prepared).toEqual(deletionPreparation(target)); return {};
    });
    expect((await remove()).state).toBe('deleted');
    expect(client.initialize).toHaveBeenCalledOnce(); expect(client.permanentDelete).toHaveBeenCalledOnce();
    expect(client.destroy).toHaveBeenCalledOnce(); expect(client.waitForManagedProcessGroupExit).toHaveBeenCalledOnce();
    expect(fence).toBe(false);
  });
  it.each([
    {}, { protocolVersion: 2, agentCapabilities: { sessionCapabilities: { delete: {} } } },
    { protocolVersion: 1, agentInfo: { version: '2.3.3' }, agentCapabilities: { sessionCapabilities: { delete: true } } },
    { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { delete: [] } } },
    { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { delete: null } } },
    { protocolVersion: 1, agentCapabilities: { sessionCapabilities: {} } },
  ])('fails closed on unsupported capabilities %j', async initialize => {
    vi.mocked(client.initialize).mockResolvedValue(initialize);
    expect((await remove()).state).toBe('unsupported'); expect(client.permanentDelete).not.toHaveBeenCalled(); expect(fence).toBe(false);
  });
  it.each(['2.3.4', '9.0.0', undefined])('uses the ACP contract regardless of diagnostic version %s', async version => {
    vi.mocked(client.initialize).mockResolvedValue({ protocolVersion: 1,
      ...(version ? { agentInfo: { version } } : {}), agentCapabilities: { sessionCapabilities: { delete: {} } } });
    expect((await remove()).state).toBe('deleted');
    expect(prepared?.nativeVersion).toBe('kimi-acp-delete-v1');
    expect(client.permanentDelete).toHaveBeenCalledWith(target.sessionId);
  });
  it.each(['2.3.3', 'kimi-acp-delete-v1'] as const)('preserves %s target and receipt after lost ACK and reload', async nativeVersion => {
    if (target.backend !== 'kimi') throw new Error('Unexpected fixture backend');
    target.nativeVersion = nativeVersion;
    vi.mocked(client.permanentDelete).mockRejectedValueOnce(new Error('Synthetic lost acknowledgement'));
    expect((await remove()).state).toBe('uncertain');
    const saved = JSON.stringify({ target, prepared });
    ({ target, prepared } = JSON.parse(saved));
    vi.mocked(client.initialize).mockResolvedValue({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { delete: {} } } });
    vi.mocked(client.permanentDelete).mockRejectedValue({ code: -32602, rpcMessage: `Unknown sessionId: ${target.sessionId}`,
      data: { sessionId: target.sessionId } });
    expect((await remove()).state).toBe('deleted');
    expect(JSON.stringify({ target, prepared })).toBe(saved);
  });
  it('accepts only exact prepared missing-ID responses after a lost ACK', async () => {
    vi.mocked(client.permanentDelete).mockRejectedValue({ code: -32602, rpcMessage: `Unknown sessionId: ${target.sessionId}`,
      data: { sessionId: target.sessionId } });
    expect((await remove()).state).toBe('uncertain');
    expect((await remove()).state).toBe('deleted');
  });
  it.each([
    { code: -32602, data: { sessionId: 'foreign' } },
    { code: -32602, message: 'session not found' },
    { code: -32603, data: {} },
  ])('does not convert arbitrary errors into deletion: %j', async error => {
    prepared = deletionPreparation(target); vi.mocked(client.permanentDelete).mockRejectedValue(error);
    expect((await remove()).state).toBe('uncertain');
  });
  it('retains a durable writer fence when maintenance exit is not proven', async () => {
    vi.mocked(client.waitForManagedProcessGroupExit).mockRejectedValue(new Error('synthetic surviving writer'));
    expect((await remove()).state).toBe('uncertain'); expect(fence).toBe(true);
  });
  it('does not send delete after a preparation write failure', async () => {
    const result = await deleteOwnedKimiSession(target, {
      persistPrepared: async () => { throw new Error('synthetic disk error'); }, persistMaintenanceState: async value => { fence = value; },
    }, factory);
    expect(result.state).toBe('held'); expect(client.permanentDelete).not.toHaveBeenCalled(); expect(fence).toBe(false);
  });
  it('holds a main/adopted duplicate without starting maintenance', async () => {
    await fs.writeFile(path.join(target.pointerRoot.path, 'main.json'), JSON.stringify({ id: target.sessionId, adopted: true }));
    expect((await remove()).state).toBe('held'); expect(factory).not.toHaveBeenCalled();
  });
  it('does not launch maintenance without durable fencing or on unsupported platforms', async () => {
    expect((await deleteOwnedKimiSession(target, {}, factory)).state).toBe('held');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('freebsd');
    expect((await remove()).state).toBe('unsupported'); expect(factory).not.toHaveBeenCalled();
  });
});
