import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

vi.mock('../../src/executor/acp/AcpClient', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/executor/acp/AcpClient')>(), AcpClient: vi.fn(),
}));

import { AcpClient } from '../../src/executor/acp/AcpClient';
import { OpenCodeExecutor } from '../../src/executor/OpenCodeExecutor';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';

class OpenCodeFixture {
  initialize = vi.fn(async () => ({}));
  newSession = vi.fn(async () => ({ sessionId: 'synthetic-session', configOptions: [] }));
  loadSession = vi.fn(async () => ({ configOptions: [] }));
  setConfigOption = vi.fn();
  prompt = vi.fn(async () => ({ stopReason: 'end_turn' }));
  deleteSession = vi.fn(async () => {});
  sendCancel = vi.fn();
  destroy = vi.fn();
  waitForExit = vi.fn(async () => {});
}

describe('OpenCode process-local question policy', () => {
  let directory: string;
  let executor: OpenCodeExecutor;
  let transports: OpenCodeFixture[];

  beforeEach(async () => {
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-question-policy-')));
    vi.spyOn(os, 'homedir').mockReturnValue(directory);
    vi.stubEnv('OPENCODE_PERMISSION', '');
    vi.stubEnv('OPENCODE_ENABLE_QUESTION_TOOL', '');
    delete process.env.OPENCODE_PERMISSION;
    delete process.env.OPENCODE_ENABLE_QUESTION_TOOL;
    transports = [];
    vi.mocked(AcpClient).mockImplementation(() => {
      const transport = new OpenCodeFixture();
      transports.push(transport);
      return transport as unknown as AcpClient;
    });
  });

  afterEach(async () => {
    await executor?.destroy();
    await executor?.waitForExit();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(directory, { recursive: true, force: true });
  });

  function create(options: { autoApprove?: boolean; delegationWorker?: boolean } = {}): void {
    executor = new OpenCodeExecutor(new DirectoryGuard([directory]), { ...options,
      initialWorkingDirectory: directory, sessionBaseDir: directory, threadId: 'synthetic' });
  }

  function childEnvironment(): NodeJS.ProcessEnv {
    const environment = vi.mocked(AcpClient).mock.calls.at(-1)?.[5]?.env;
    if (!environment) throw new Error('Synthetic child environment was not supplied');
    return environment;
  }

  it('disables the opt-in question tool and adds deny without modifying the parent environment', async () => {
    vi.stubEnv('OPENCODE_ENABLE_QUESTION_TOOL', 'true');
    vi.stubEnv('SYNTHETIC_POLICY_TEST', 'inherited');
    create();
    expect(await executor.execute('synthetic task')).toMatchObject({ success: true });
    const environment = childEnvironment();
    expect(environment.OPENCODE_PERMISSION).toBe('{"question":"deny"}');
    expect(environment.OPENCODE_ENABLE_QUESTION_TOOL).toBe('false');
    expect(environment.SYNTHETIC_POLICY_TEST).toBe('inherited');
    expect(process.env.OPENCODE_PERMISSION).toBeUndefined();
    expect(process.env.OPENCODE_ENABLE_QUESTION_TOOL).toBe('true');
    expect(transports[0].setConfigOption).not.toHaveBeenCalled();
    expect(vi.mocked(AcpClient).mock.calls[0].slice(0, 2)).toEqual(['opencode', ['acp']]);
  });

  it('preserves other rules and places question deny after wildcard rules', async () => {
    const existing = '{"question":"allow","bash":{"git *":"allow","*":"ask"},"*":"allow","edit":"deny"}';
    vi.stubEnv('OPENCODE_PERMISSION', existing);
    create({ autoApprove: true });
    await executor.execute('synthetic task');
    const permissions = JSON.parse(childEnvironment().OPENCODE_PERMISSION!);
    expect(permissions).toEqual({ bash: { 'git *': 'allow', '*': 'ask' }, '*': 'allow', edit: 'deny', question: 'deny' });
    expect(Object.keys(permissions)).toEqual(['bash', '*', 'edit', 'question']);
    expect(process.env.OPENCODE_PERMISSION).toBe(existing);
  });

  it('preserves Windows permission aliases and emits one canonical key per override', async () => {
    vi.stubEnv('opencode_permission', '{"edit":"ask"}');
    vi.stubEnv('opencode_enable_question_tool', 'true');
    create();
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      expect(await executor.execute('synthetic task')).toMatchObject({ success: true });
      const environment = childEnvironment();
      expect(JSON.parse(environment.OPENCODE_PERMISSION!)).toEqual({ edit: 'ask', question: 'deny' });
      expect(environment.OPENCODE_ENABLE_QUESTION_TOOL).toBe('false');
      expect(Object.keys(environment).filter(key => key.toUpperCase() === 'OPENCODE_PERMISSION')).toEqual(['OPENCODE_PERMISSION']);
      expect(Object.keys(environment).filter(key => key.toUpperCase() === 'OPENCODE_ENABLE_QUESTION_TOOL')).toEqual(['OPENCODE_ENABLE_QUESTION_TOOL']);
      expect(process.env.opencode_permission).toBe('{"edit":"ask"}');
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });

  it.each(['allow', 'ask', 'deny'])('preserves a whole-policy %s action as a wildcard', async action => {
    vi.stubEnv('OPENCODE_PERMISSION', JSON.stringify(action));
    create();
    await executor.execute('synthetic task');
    expect(JSON.parse(childEnvironment().OPENCODE_PERMISSION!)).toEqual({ '*': action, question: 'deny' });
  });

  it.each(['{synthetic-private-invalid', 'null', '[]', 'false', '"invalid"', '{"bash":"invalid"}',
    '{"bash":{"*":true}}', '{"question":{"*":"allow"}}'])
    ('rejects invalid permission environment before spawning without echoing its contents: %s', async value => {
      vi.stubEnv('OPENCODE_PERMISSION', value);
      create();
      const result = await executor.execute('synthetic task');
      expect(result).toMatchObject({ success: false, error: 'OpenCode OPENCODE_PERMISSION must contain a valid JSON permission object before automatic approval can disable questions.' });
      expect(AcpClient).not.toHaveBeenCalled();
      expect(executor.isProcessRunning()).toBe(false);
    });

  it('allows a corrected permission environment to retry initialization', async () => {
    vi.stubEnv('OPENCODE_PERMISSION', '{invalid');
    create();
    expect(await executor.execute('first')).toMatchObject({ success: false });
    vi.stubEnv('OPENCODE_PERMISSION', '{"edit":"ask"}');
    expect(await executor.execute('second')).toMatchObject({ success: true });
    expect(JSON.parse(childEnvironment().OPENCODE_PERMISSION!)).toEqual({ edit: 'ask', question: 'deny' });
    expect(AcpClient).toHaveBeenCalledOnce();
  });

  it('leaves manual approval environments untouched, including invalid inherited policy', async () => {
    vi.stubEnv('OPENCODE_PERMISSION', '{synthetic-invalid');
    vi.stubEnv('OPENCODE_ENABLE_QUESTION_TOOL', 'true');
    create({ autoApprove: false });
    expect(await executor.execute('synthetic task')).toMatchObject({ success: true });
    expect(vi.mocked(AcpClient).mock.calls[0][5]?.env).toBeUndefined();
    expect(process.env.OPENCODE_PERMISSION).toBe('{synthetic-invalid');
    expect(process.env.OPENCODE_ENABLE_QUESTION_TOOL).toBe('true');
  });

  it('rebuilds process-local policy on resume while preserving managed launch options', async () => {
    create({ delegationWorker: true });
    await executor.execute('first');
    expect(vi.mocked(AcpClient).mock.calls[0][4]).toBe(true);
    expect(vi.mocked(AcpClient).mock.calls[0][5]?.delegationWorker).toBe(true);
    await executor.configureDelegation({ url: 'http://127.0.0.1:9999/', token: 'synthetic-token' });
    vi.stubEnv('OPENCODE_PERMISSION', '{"read":"ask"}');
    expect(await executor.execute('second')).toMatchObject({ success: true });
    expect(transports[0].destroy).toHaveBeenCalledOnce();
    expect(transports[1].loadSession).toHaveBeenCalled();
    expect(transports[1].newSession).not.toHaveBeenCalled();
    expect(JSON.parse(childEnvironment().OPENCODE_PERMISSION!)).toEqual({ read: 'ask', question: 'deny' });
    expect(childEnvironment().OPENCODE_ENABLE_QUESTION_TOOL).toBe('false');
  });
});
