import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { ownedSpawn } from '../../src/delegation/OwnershipRuntime';
import { ZCodeClient } from '../../src/executor/zcode/ZCodeClient';

vi.mock('../../src/delegation/OwnershipRuntime', () => ({ ownedSpawn: vi.fn() }));

describe('ZCode maintenance transport', () => {
  let home: string, client: ZCodeClient, child: any, frames: any[];
  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-maintenance-')));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    for (const key of ['HOME', 'USERPROFILE', 'ZCODE_HOME', 'ZCODE_STORAGE_DIR', 'CODEX_HOME']) vi.stubEnv(key, home);
    frames = [];
    child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = Object.assign(new EventEmitter(), { write: vi.fn((line: string) => { frames.push(JSON.parse(line)); }), end: vi.fn() });
    child.kill = vi.fn(() => { child.killed = true; child.emit('close', 0, null); return true; });
    vi.mocked(ownedSpawn).mockReturnValue(child);
    client = new ZCodeClient({ cwd: home, maintenance: true,
      launch: { command: 'synthetic-zcode', args: [], env: { HOME: home } } }, {});
  });
  afterEach(async () => {
    try { client?.destroy(); await client?.waitForExit(); await fs.rm(home, { recursive: true, force: true }); }
    finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
  });
  const reply = (id: number, result: unknown) => child.stdout.emit('data', JSON.stringify({ id, result }) + '\n');
  it('sends exactly one root and an empty memory-directory list', async () => {
    const request = client.requestSessionData('measure', 'owned-root');
    expect(frames[0]).toEqual({ id: 1, method: 'v4/storage/sessionData/measure', params: { sessionIds: ['owned-root'], directories: [] } });
    reply(1, { sessions: [{ sessionId: 'owned-root', bytes: 0 }], memory: [] });
    await request;
    const deletion = client.requestSessionData('purge', 'owned-root');
    expect(frames[1].params).toEqual({ sessionIds: ['owned-root'], directories: [] });
    reply(2, { deleted: [{ sessionId: 'owned-root', bytes: 0 }], kept: [], failed: [], memory: [] });
    await deletion;
  });
  it('never starts, resumes or prompts a session through the maintenance transport', async () => {
    await expect(client.newSession(home)).rejects.toThrow('Disallowed');
    await expect(client.loadSession('owned-root', home)).rejects.toThrow('Disallowed');
    await expect(client.prompt('owned-root', [{ type: 'text', text: 'Synthetic task' }])).rejects.toThrow('Disallowed');
    await expect(client.requestSessionData('purge', '../outside')).rejects.toThrow('Invalid');
    expect(frames).toEqual([]);
  });
  it('denies provider-header requests without reading credentials and suppresses private stderr', async () => {
    const credentials = vi.spyOn(client as any, 'codingPlanApiKey');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    child.stderr.emit('data', Buffer.from('Synthetic private diagnostic'));
    child.stdout.emit('data', JSON.stringify({ id: 900, method: 'interaction/requestProviderRuntimeHeaders', params: { providerId: 'synthetic' } }) + '\n');
    expect(credentials).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled();
    expect(frames).toEqual([{ id: 900, error: { code: -32601, message: 'Unavailable during maintenance' } }]);
  });
  it('preserves the protocol error code without propagating raw error strings', async () => {
    const request = client.requestSessionData('measure', 'owned-root');
    child.stdout.emit('data', JSON.stringify({ id: 1, error: { code: -32601, message: 'Synthetic private response' } }) + '\n');
    await expect(request).rejects.toMatchObject({ code: -32601, message: 'ZCode maintenance RPC failed' });
  });
});
