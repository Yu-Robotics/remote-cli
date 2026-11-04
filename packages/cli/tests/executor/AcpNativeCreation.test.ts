import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcpExecutor } from '../../src/executor/AcpExecutor';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import type { NativeSessionDeletionTarget } from '../../src/delegation/NativeSessionDeletion';

describe('backend-specific ACP native creation observation', () => {
  let home: string;
  const executors: AcpExecutor[] = [];
  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'acp-native-hook-')));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(async () => {
    for (const executor of executors.splice(0)) await executor.destroy();
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    await fs.rm(home, { recursive: true, force: true });
  });
  function create(prepareNativeSession?: (cwd: string) => Promise<void>) {
    const id = `ses_${randomUUID().replace(/-/g, '')}`;
    const lane = `delegate-lane-${randomUUID()}`;
    const transport = {
      initialize: vi.fn(async () => ({ protocolVersion: 1 })),
      newSession: vi.fn(async () => ({ sessionId: id, configOptions: [] })),
      loadSession: vi.fn(async () => ({ sessionId: id, configOptions: [] })),
      setConfigOption: vi.fn(async () => ({ configOptions: [] })),
      prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
      destroy: vi.fn(), sendCancel: vi.fn(), waitForExit: vi.fn(async () => {}),
      waitForManagedProcessGroupExit: vi.fn(async () => {}),
    };
    // Target-schema validation belongs to the store; this fixture tests dispatch ordering.
    const target = { sessionId: id } as NativeSessionDeletionTarget;
    const capture = vi.fn(async (session: { sessionId: string; pointer: string }) => {
      expect(session.sessionId).toBe(id);
      expect(JSON.parse(await fs.readFile(session.pointer, 'utf8')).id).toBe(id);
      return target;
    });
    const executor = new AcpExecutor(new DirectoryGuard([home]), {
      acpCommand: 'synthetic', acpArgs: [], backendLabel: 'Synthetic', sessionNamespace: 'synthetic-sessions',
      effortConfigId: 'effort', effortAutoValue: 'auto', installCommand: 'synthetic install', authCommand: 'synthetic login',
      threadId: lane, delegationWorker: true, initialWorkingDirectory: home, managedLifecycle: true,
      clientFactory: () => transport as any, nativeSessionCapture: capture, prepareNativeSession,
    });
    const observe = vi.fn(async () => {});
    const failure = vi.fn(async () => {});
    executor.observeNativeSessionCreation(observe, failure);
    executors.push(executor);
    return { executor, transport, capture, observe, failure, target };
  }

  it('awaits fresh capture and durable observation before prompting, without recapturing reuse', async () => {
    const fixture = create();
    expect((await fixture.executor.execute('first', {})).success).toBe(true);
    expect(fixture.capture).toHaveBeenCalledOnce();
    expect(fixture.observe).toHaveBeenCalledWith(fixture.target);
    expect(fixture.observe.mock.invocationCallOrder[0]).toBeLessThan(fixture.transport.prompt.mock.invocationCallOrder[0]);
    expect((await fixture.executor.execute('reuse', {})).success).toBe(true);
    expect(fixture.capture).toHaveBeenCalledOnce();
    expect(fixture.failure).not.toHaveBeenCalled();
  });

  it('persists native scope before starting transport initialization', async () => {
    const prepare = vi.fn(async (cwd: string) => { expect(cwd).toBe(home); });
    const fixture = create(prepare);
    expect((await fixture.executor.execute('first', {})).success).toBe(true);
    expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(fixture.transport.initialize.mock.invocationCallOrder[0]);
    expect((await fixture.executor.execute('reuse', {})).success).toBe(true);
    expect(prepare).toHaveBeenCalledOnce();
  });

  it('does not start a transport when reset retires pending scope preparation', async () => {
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const prepare = vi.fn(async () => waiting);
    const fixture = create(prepare);
    const task = fixture.executor.execute('cancelled', {});
    try {
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
      fixture.executor.resetContext();
    } finally { release(); }
    expect((await task).success).toBe(false);
    expect(fixture.transport.initialize).not.toHaveBeenCalled();
    expect(fixture.transport.prompt).not.toHaveBeenCalled();
  });

  it('records capture failure before continuing the normal task', async () => {
    const fixture = create();
    fixture.capture.mockRejectedValue(new Error('Synthetic unsupported metadata'));
    expect((await fixture.executor.execute('continue', {})).success).toBe(true);
    expect(fixture.failure).toHaveBeenCalledOnce();
    expect(fixture.failure.mock.invocationCallOrder[0]).toBeLessThan(fixture.transport.prompt.mock.invocationCallOrder[0]);
    expect(fixture.observe).not.toHaveBeenCalled();
  });

  it('prevents dispatch when durable creation observation fails', async () => {
    const fixture = create();
    fixture.observe.mockRejectedValue(new Error('Synthetic persistence failure'));
    expect((await fixture.executor.execute('blocked', {})).success).toBe(false);
    expect(fixture.transport.prompt).not.toHaveBeenCalled();
    expect(fixture.failure).toHaveBeenCalledOnce();
  });
});
