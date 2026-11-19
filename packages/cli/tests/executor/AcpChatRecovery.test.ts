import { describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { KimiExecutor } from '../../src/executor/KimiExecutor';
import { OpenCodeExecutor } from '../../src/executor/OpenCodeExecutor';
import { ZCodeExecutor } from '../../src/executor/ZCodeExecutor';
import type { AcpEventCallbacks } from '../../src/executor/acp/AcpClient';
import type { AcpContentBlock } from '../../src/executor/acp/AcpTypes';
import { kimiModeOption } from './kimiAcpFixture';

const backends = [KimiExecutor, OpenCodeExecutor, ZCodeExecutor] as const;

async function retryChat(Backend: typeof backends[number], managedTools: boolean, wrongIdentity = false) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'acp-chat-retry-')));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  const cwd = path.join(home, 'project');
  const sessions = path.join(home, 'sessions');
  const pointer = path.join(sessions, 'thread.json');
  const load = vi.fn(async (id: string) => ({ sessionId: id, configOptions: [kimiModeOption()] }));
  const create = vi.fn(async () => ({ sessionId: 'replacement', configOptions: [kimiModeOption()] }));
  const prompts: Array<{ id: string; blocks: AcpContentBlock[] }> = [];
  let executor: InstanceType<typeof backends[number]> | undefined;
  try {
    await fs.mkdir(cwd);
    await fs.mkdir(sessions);
    await fs.writeFile(pointer, JSON.stringify({ id: 'original', cwd }));
    executor = new Backend(new DirectoryGuard([cwd]), {
      initialWorkingDirectory: cwd, sessionBaseDir: sessions, threadId: 'thread',
      clientFactory: (events: AcpEventCallbacks) => ({
        initialize: async () => ({ protocolVersion: 1 }),
        loadSession: load,
        newSession: create,
        prompt: async (id, blocks) => {
          prompts.push({ id, blocks });
          events.onTextChunk?.({ type: 'text', text: 'Recovered answer' });
          return { stopReason: 'end_turn' };
        },
        setConfigOption: async (_id, _option, value) => ({ configOptions: [kimiModeOption(value)] }),
        deleteSession: vi.fn(), sendCancel: vi.fn(), destroy: vi.fn(),
      }),
    });
    expect(executor.getSessionId()).toBe('original');
    if (managedTools) {
      await executor.configureManagedTools({ url: 'http://127.0.0.1:1', token: 'fixture', groups: ['scheduling'] });
    }
    if (wrongIdentity) load.mockResolvedValueOnce({ sessionId: 'other', configOptions: [] });
    else load.mockRejectedValueOnce(new Error('Temporary transport disconnect'));
    const failed = await executor.execute('first message');
    expect(load.mock.calls[0][0]).toBe('original');
    const afterFailure = {
      success: failed.success, savedId: JSON.parse(await fs.readFile(pointer, 'utf8')).id,
      prompts: prompts.length, allocations: create.mock.calls.length,
    };
    const retry = await executor.execute('please continue');
    return { afterFailure, error: failed.error, retry, prompts, loads: load.mock.calls.map(([id]) => id),
      savedId: JSON.parse(await fs.readFile(pointer, 'utf8')).id, allocations: create.mock.calls.length };
  } finally {
    try { await executor?.destroy(); }
    finally {
      vi.restoreAllMocks(); vi.unstubAllEnvs();
      await fs.rm(home, { recursive: true, force: true });
    }
  }
}

describe.each(backends.map(Backend => ({ name: Backend.name, Backend })))('$name foreground session recovery', ({ Backend }) => {
  it.each([
    { managedTools: true, wrongIdentity: false }, { managedTools: true, wrongIdentity: true },
    { managedTools: false, wrongIdentity: false }, { managedTools: false, wrongIdentity: true },
  ])('retries on the original session (managed tools: $managedTools, wrong identity: $wrongIdentity)', async ({ managedTools, wrongIdentity }) => {
    const result = await retryChat(Backend, managedTools, wrongIdentity);
    expect(result.error).toContain(wrongIdentity ? 'different conversation' : 'Temporary transport disconnect');
    expect(result.afterFailure).toEqual({ success: false, savedId: 'original', prompts: 0, allocations: 0 });
    expect(result.retry).toMatchObject({ success: true, output: 'Recovered answer' });
    expect(result.prompts).toEqual([{ id: 'original', blocks: [{ type: 'text', text: 'please continue' }] }]);
    expect(result.loads).toEqual(['original', 'original']);
    expect(result.savedId).toBe('original');
    expect(result.allocations).toBe(0);
  });

});
