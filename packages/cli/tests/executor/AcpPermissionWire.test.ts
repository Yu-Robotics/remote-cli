import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { Readable, Writable } from 'stream';

vi.mock('child_process', async importOriginal => ({
  ...await importOriginal<typeof import('child_process')>(), spawn: vi.fn(),
}));

import { spawn } from 'child_process';
import { AcpClient } from '../../src/executor/acp/AcpClient';
import type { AcpPermissionOption } from '../../src/executor/acp/AcpTypes';
import { KimiExecutor } from '../../src/executor/KimiExecutor';
import { OpenCodeExecutor } from '../../src/executor/OpenCodeExecutor';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';

const toolOptions: AcpPermissionOption[] = [
  { optionId: 'approve-once', kind: 'allow_once', name: 'Once' },
  { optionId: 'approve-session', kind: 'allow_always', name: 'Session' },
  { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
];
const questionOptions: AcpPermissionOption[] = [
  { optionId: 'q0_opt_0', kind: 'allow_once', name: 'First answer' },
  { optionId: 'q0_opt_1', kind: 'allow_once', name: 'Second answer' },
  { optionId: 'q0_skip', kind: 'reject_once', name: 'Skip' },
];

/** A synthetic agent executes work only after accepting a schema-valid NDJSON reply. */
class PermissionAgent extends EventEmitter {
  readonly stdout = new Readable({ read() {} });
  readonly stderr = new Readable({ read() {} });
  readonly stdin = new Writable({
    write: (data, _encoding, done) => {
      for (const line of data.toString().trim().split('\n')) {
        const frame = JSON.parse(line);
        queueMicrotask(() => this.receive(frame));
      }
      done();
    },
  });
  readonly replies: any[] = [];
  operations = 0;
  protocolErrors = 0;
  killed = false;
  private promptId = 0;

  constructor(readonly options: AcpPermissionOption[]) { super(); }

  kill(): boolean {
    if (!this.killed) {
      this.killed = true;
      this.stdout.push(null);
      this.stderr.push(null);
      this.emit('close', 0, null);
    }
    return true;
  }

  private send(frame: object): void { this.stdout.push(`${JSON.stringify(frame)}\n`); }

  private receive(frame: any): void {
    if (frame.method === 'initialize') {
      this.send({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } });
    } else if (frame.method === 'session/new' || frame.method === 'session/load') {
      this.send({ jsonrpc: '2.0', id: frame.id, result: { sessionId: 'synthetic-session', configOptions: [] } });
    } else if (frame.method === 'session/prompt') {
      this.promptId = frame.id;
      this.send({ jsonrpc: '2.0', id: 900, method: 'session/request_permission', params: {
        sessionId: 'synthetic-session', toolCall: { title: this.options === questionOptions ? 'AskUserQuestion' : 'Synthetic command' },
        options: this.options,
      } });
    } else if (frame.id === 900) {
      this.replies.push(frame);
      const outcome = frame.result?.outcome;
      const selected = outcome && typeof outcome === 'object' && outcome.outcome === 'selected'
        && typeof outcome.optionId === 'string'
        && this.options.some(option => option.optionId === outcome.optionId
          && (option.kind === 'allow_once' || option.kind === 'allow_always'));
      const cancelled = outcome && typeof outcome === 'object' && outcome.outcome === 'cancelled'
        && !Object.hasOwn(outcome, 'optionId');
      if (!selected && !cancelled) {
        this.protocolErrors++;
        this.send({ jsonrpc: '2.0', id: this.promptId, error: { code: -32602, message: 'Invalid ACP permission result' } });
        return;
      }
      if (selected) this.operations++;
      this.send({ jsonrpc: '2.0', id: this.promptId, result: { stopReason: selected ? 'end_turn' : 'cancelled' } });
    }
  }
}

describe.each(['kimi', 'opencode'] as const)('%s ACP permission interoperability', backend => {
  let directory: string;
  let originalHome: string | undefined;
  let executor: KimiExecutor | OpenCodeExecutor | undefined;
  let agent: PermissionAgent | undefined;

  beforeEach(async () => {
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'remote-cli-acp-permission-')));
    originalHome = process.env.HOME;
    process.env.HOME = directory;
    vi.spyOn(os, 'homedir').mockReturnValue(directory);
  });

  afterEach(async () => {
    await executor?.destroy();
    await executor?.waitForExit();
    agent?.kill();
    executor = undefined;
    agent = undefined;
    vi.restoreAllMocks();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await fs.rm(directory, { recursive: true, force: true });
  });

  function create(autoApprove: boolean, options = toolOptions): void {
    agent = new PermissionAgent(options);
    vi.mocked(spawn).mockReturnValue(agent as any);
    const settings = { autoApprove, initialWorkingDirectory: directory,
      sessionBaseDir: path.join(directory, 'sessions'),
      clientFactory: (callbacks: ConstructorParameters<typeof AcpClient>[3], cwd: string) =>
        new AcpClient('synthetic-acp', ['acp'], cwd, callbacks) };
    executor = backend === 'kimi' ? new KimiExecutor(new DirectoryGuard([directory]), settings)
      : new OpenCodeExecutor(new DirectoryGuard([directory]), settings);
  }

  it('automatically authorizes a tool through a schema-valid wire response', async () => {
    create(true);
    expect(await executor!.execute('Synthetic task')).toMatchObject({ success: true });
    expect(agent!.operations).toBe(1);
    expect(agent!.protocolErrors).toBe(0);
    expect(agent!.replies[0].result.outcome.optionId).toBe('approve-once');
  });

  it.each(['yes', 'always', 'no', 'cancel'])('preserves explicit manual policy for %s', async answer => {
    create(false);
    const pending = executor!.execute('Synthetic task');
    await vi.waitFor(() => expect(executor!.isWaitingInput()).toBe(true));
    expect(agent!.operations).toBe(0);
    expect(agent!.replies).toHaveLength(0);
    expect(executor!.sendInput(answer)).toBe(true);
    const allowed = answer === 'yes' || answer === 'always';
    expect(await pending).toMatchObject({ success: allowed });
    expect(agent!.operations).toBe(allowed ? 1 : 0);
    expect(agent!.protocolErrors).toBe(0);
    if (allowed) expect(agent!.replies[0].result.outcome.optionId).toBe(answer === 'yes' ? 'approve-once' : 'approve-session');
  });

  it.each(['2', 'skip'])('keeps questions interactive with auto-approval enabled: %s', async answer => {
    create(true, questionOptions);
    const pending = executor!.execute('Synthetic task');
    await vi.waitFor(() => expect(executor!.isWaitingInput()).toBe(true));
    expect(agent!.replies).toHaveLength(0);
    expect(executor!.sendInput(answer)).toBe(true);
    expect(await pending).toMatchObject({ success: answer === '2' });
    expect(agent!.operations).toBe(answer === '2' ? 1 : 0);
    expect(agent!.protocolErrors).toBe(0);
    if (answer === '2') expect(agent!.replies[0].result.outcome.optionId).toBe('q0_opt_1');
  });
});
