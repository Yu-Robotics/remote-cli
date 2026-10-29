import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { OpenCodeExecutor } from '../../src/executor/OpenCodeExecutor';
import { KimiExecutor } from '../../src/executor/KimiExecutor';
import { ZCodeExecutor } from '../../src/executor/ZCodeExecutor';
import { DshExecutor } from '../../src/executor/DshExecutor';
import { PiExecutor } from '../../src/executor/PiExecutor';
import { CodexAppServerExecutor } from '../../src/executor/CodexAppServerExecutor';
import type { AcpTransport } from '../../src/executor/acp/AcpClient';
import type { IExecutor } from '../../src/executor/IExecutor';

class AcpFixture implements AcpTransport {
  initialize = vi.fn(async () => ({}));
  newSession = vi.fn(async () => ({ sessionId: 'synthetic-session', configOptions: [] }));
  loadSession = vi.fn(async () => ({ configOptions: [] }));
  prompt = vi.fn(async () => ({ stopReason: 'end_turn' }));
  setConfigOption = vi.fn(async () => ({ configOptions: [] }));
  deleteSession = vi.fn(async () => undefined);
  sendCancel = vi.fn();
  destroy = vi.fn();
  waitForExit = vi.fn(async () => undefined);
  waitForManagedProcessGroupExit = vi.fn(async () => undefined);
}

describe('managed executor group-exit contracts', () => {
  let root: string;
  let guard: DirectoryGuard;
  let executor: IExecutor | undefined;
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'executor-exit-contract-')));
    vi.spyOn(os, 'homedir').mockReturnValue(root);
    vi.stubEnv('HOME', root); vi.stubEnv('USERPROFILE', root);
    guard = new DirectoryGuard([root]);
  });
  afterEach(async () => {
    await executor?.destroy();
    executor = undefined;
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each([OpenCodeExecutor, KimiExecutor, ZCodeExecutor, DshExecutor])('%s preserves evidence from retired ACP transports', async Executor => {
    const first = new AcpFixture();
    const second = new AcpFixture();
    let uncertain = true;
    first.waitForManagedProcessGroupExit.mockImplementation(async () => { if (uncertain) throw new Error('Synthetic group still alive'); });
    const factory = vi.fn().mockReturnValueOnce(first).mockReturnValue(second);
    executor = new Executor(guard, { initialWorkingDirectory: root, threadId: 'synthetic-worker',
      delegationWorker: true, sessionBaseDir: path.join(root, 'sessions'), clientFactory: factory });
    expect((await executor.execute('fixture')).success).toBe(true);
    executor.resetContext();
    expect((await executor.execute('second fixture')).success).toBe(true);
    await executor.destroy();
    await expect(executor.waitForExit!()).resolves.toBeUndefined();
    await expect(executor.waitForManagedProcessGroupExit!()).rejects.toThrow('Synthetic group still alive');
    expect(first.waitForManagedProcessGroupExit).toHaveBeenCalledTimes(1);
    expect(second.waitForManagedProcessGroupExit).toHaveBeenCalledTimes(1);
    uncertain = false;
    await executor.waitForManagedProcessGroupExit!();
    expect(first.waitForManagedProcessGroupExit).toHaveBeenCalledTimes(2);
    expect(second.waitForManagedProcessGroupExit).toHaveBeenCalledTimes(1);
  });

  it('does not add group checks to ordinary ACP transport teardown', async () => {
    const transport = new AcpFixture();
    executor = new OpenCodeExecutor(guard, { initialWorkingDirectory: root, sessionBaseDir: path.join(root, 'sessions'),
      clientFactory: () => transport });
    await executor.execute('fixture'); await executor.destroy(); await executor.waitForExit!();
    expect(transport.waitForManagedProcessGroupExit).not.toHaveBeenCalled();
    await expect(executor.waitForManagedProcessGroupExit!()).rejects.toThrow('not enabled');
  });

  it('rejects missing ACP group evidence without changing existing transport wait semantics', async () => {
    const transport = new AcpFixture();
    Object.assign(transport, { waitForManagedProcessGroupExit: undefined });
    executor = new OpenCodeExecutor(guard, { initialWorkingDirectory: root, delegationWorker: true,
      sessionBaseDir: path.join(root, 'sessions'), clientFactory: () => transport });
    await executor.execute('fixture'); await executor.destroy(); await executor.waitForExit!();
    await expect(executor.waitForManagedProcessGroupExit!()).rejects.toThrow('cannot confirm');
  });

  it('retains Pi group obligations after an old transport has stopped', async () => {
    const first = { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined),
      isRunning: () => false, onEvent: () => () => undefined, send: vi.fn(), request: vi.fn(),
      waitForExit: vi.fn(async () => undefined), waitForManagedProcessGroupExit: vi.fn(async () => undefined) };
    const second = { ...first, waitForManagedProcessGroupExit: vi.fn(async () => undefined) };
    let uncertain = true;
    first.waitForManagedProcessGroupExit.mockImplementation(async () => { if (uncertain) throw new Error('Synthetic group still alive'); });
    executor = new PiExecutor(guard, { initialWorkingDirectory: root, threadId: 'synthetic-pi', delegationWorker: true,
      clientFactory: vi.fn().mockReturnValueOnce(first).mockReturnValue(second) });
    executor.resetContext();
    await executor.destroy(); await executor.waitForExit!();
    await expect(executor.waitForManagedProcessGroupExit!()).rejects.toThrow('Synthetic group still alive');
    uncertain = false;
    await executor.waitForManagedProcessGroupExit!();
    expect(first.waitForManagedProcessGroupExit).toHaveBeenCalledTimes(2);
    expect(second.waitForManagedProcessGroupExit).toHaveBeenCalledTimes(1);
  });

  it('forwards Codex group uncertainty independently of transport closure', async () => {
    const proof = vi.fn(async () => { throw new Error('Synthetic group still alive'); });
    executor = new CodexAppServerExecutor(guard, { initialWorkingDirectory: root, threadId: 'synthetic-codex', delegationWorker: true,
      clientFactory: () => ({ start: async () => undefined, stop: async () => undefined,
        isRunning: () => false, onMessage: () => () => undefined, request: vi.fn(), respond: vi.fn(), respondError: vi.fn(),
        setWorkingDirectory: vi.fn(), waitForExit: async () => undefined, waitForManagedProcessGroupExit: proof }) });
    await executor.destroy(); await executor.waitForExit!();
    await expect(executor.waitForManagedProcessGroupExit!()).rejects.toThrow('Synthetic group still alive');
    proof.mockResolvedValueOnce(undefined as never);
    await executor.waitForManagedProcessGroupExit!();
  });
});
