import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { KimiExecutor } from '../../src/executor/KimiExecutor';
import type { AcpEventCallbacks, AcpTransport } from '../../src/executor/acp/AcpClient';
import type { AcpConfigOption, AcpContentBlock, AcpSessionResult } from '../../src/executor/acp/AcpTypes';

const originalHome = process.env.HOME;
const originalHomedir = os.homedir();

const configOptions: AcpConfigOption[] = [
  {
    id: 'model', name: 'Model', type: 'select', currentValue: 'kimi-k2.7',
    options: [{ value: 'kimi-k2.7', name: 'Kimi K2.7' }],
  },
  {
    id: 'thinking', name: 'Thinking', type: 'select', currentValue: 'high',
    options: ['off', 'low', 'medium', 'high'].map((value) => ({ value, name: value })),
  },
];

class FakeKimiTransport implements AcpTransport {
  initialize = vi.fn().mockResolvedValue({ protocolVersion: 1 });
  newSession = vi.fn(async (): Promise<AcpSessionResult> => ({ sessionId: 'session-kimi', configOptions }));
  loadSession = vi.fn(async (): Promise<AcpSessionResult> => ({ configOptions }));
  prompt = vi.fn(async (_sessionId: string, _blocks: AcpContentBlock[]) => ({ stopReason: 'end_turn' }));
  setConfigOption = vi.fn(async (): Promise<AcpSessionResult> => ({ configOptions }));
  deleteSession = vi.fn().mockResolvedValue(undefined);
  sendCancel = vi.fn();
  destroy = vi.fn();
}

describe('KimiExecutor', () => {
  let home: string;
  let project: string;
  let transport: FakeKimiTransport;
  let callbacks: AcpEventCallbacks;
  let executor: KimiExecutor;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(originalHomedir, '.kimi-executor-test-'));
    project = path.join(home, 'project');
    await fs.mkdir(project);
    process.env.HOME = home;
    transport = new FakeKimiTransport();
    callbacks = {};
    executor = new KimiExecutor(new DirectoryGuard([home]), {
      initialWorkingDirectory: project,
      threadId: 'thread-kimi',
      sessionBaseDir: path.join(home, '.remote-cli', 'kimi-sessions'),
      clientFactory: (next) => {
        callbacks = next;
        return transport;
      },
    });
  });

  afterEach(async () => {
    await executor.destroy();
    await fs.rm(home, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it('runs Kimi turns over ACP and persists the session pointer', async () => {
    transport.prompt.mockImplementationOnce(async () => {
      callbacks.onTextChunk?.({ type: 'text', text: 'Kimi response' });
      return { stopReason: 'end_turn' };
    });
    const result = await executor.execute('hello', {});
    expect(result).toMatchObject({ success: true, output: 'Kimi response' });
    expect(transport.newSession).toHaveBeenCalledWith(project);
    const stored = JSON.parse(await fs.readFile(path.join(home, '.remote-cli', 'kimi-sessions', 'thread-kimi.json'), 'utf8'));
    expect(stored.id).toBe('session-kimi');
  });

  it('lists models from Kimi ACP config options', async () => {
    await expect(executor.listModels()).resolves.toEqual([
      expect.objectContaining({ id: 'kimi-k2.7', supportedReasoningEfforts: ['off', 'low', 'medium', 'high'] }),
    ]);
  });

  it('maps effort to the Kimi thinking config option', async () => {
    await executor.listModels();
    await expect(executor.setEffort('high')).resolves.toMatchObject({ success: true });
    expect(transport.setConfigOption).toHaveBeenCalledWith('session-kimi', 'thinking', 'high');
  });

  it('maps auto effort to Kimi automatic thinking selection', async () => {
    await executor.listModels();
    await expect(executor.setEffort('auto')).resolves.toMatchObject({ success: true });
    expect(transport.setConfigOption).toHaveBeenCalledWith('session-kimi', 'thinking', 'on');
  });

  it('returns Kimi login guidance when ACP requires authentication', async () => {
    transport.newSession.mockRejectedValueOnce(new Error('ACP error -32000: Authentication required'));
    await expect(executor.execute('hello', {})).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('kimi login'),
    });
  });
});
