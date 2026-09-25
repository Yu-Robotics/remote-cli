import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ClaudePersistentExecutor } from '../src/executor/ClaudePersistentExecutor';
import { DirectoryGuard } from '../src/security/DirectoryGuard';
import type { ClaudeSandboxConfig } from '../src/types/config';

vi.mock('child_process', () => ({ spawn: vi.fn() }));

describe('Claude sandbox launch policy', () => {
  let home: string;
  let executor: ClaudePersistentExecutor | undefined;
  let child: any;

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-launch-test-')));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.spyOn(os, 'platform').mockReturnValue('linux');
    vi.stubEnv('PATH', home);
    vi.useFakeTimers();
    child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: vi.fn(), end: vi.fn() };
    child.kill = vi.fn();
    vi.mocked(spawn).mockReturnValue(child);
  });

  afterEach(async () => {
    child.emit('close', 0, null);
    await executor?.destroy();
    executor = undefined;
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  function create(config?: ClaudeSandboxConfig): ClaudePersistentExecutor {
    executor = new ClaudePersistentExecutor(new DirectoryGuard([home]), home, 'test', undefined, config);
    // The real MCP socket protocol has its own tests; this test checks the CLI contract.
    vi.spyOn(executor as any, 'ensureApprovalServer').mockResolvedValue('/tmp/test-approval.sock');
    return executor;
  }

  it.each(['workspace-write', 'read-only'] as const)('launches %s with mandatory enforcement and approval rules', async mode => {
    for (const tool of ['bwrap', 'socat']) fs.writeFileSync(path.join(home, tool), '', { mode: 0o700 });
    const result = create({ mode }).execute('write a file');
    await vi.advanceTimersByTimeAsync(1000);
    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('default');
    expect(args).not.toContain('--dangerously-skip-permissions');
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
    expect(settings.sandbox.failIfUnavailable).toBe(true);
    expect(settings.permissions.ask).toContain('Write');
    expect(args).toContain('--permission-prompt-tool');
    child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', subtype: 'success' }) + '\n'));
    await expect(result).resolves.toMatchObject({ success: true });
  });

  it('returns a dependency error without spawning or retrying an unsandboxed process', async () => {
    const restricted = create({ mode: 'read-only' });
    await expect(restricted.execute('write a file')).resolves.toMatchObject({
      success: false, error: expect.stringContaining('dependencies missing from PATH: bwrap, socat'),
    });
    await vi.advanceTimersByTimeAsync(10000);
    expect(spawn).not.toHaveBeenCalled();
    expect(restricted.isProcessRunning()).toBe(false);
  });

  it.each([undefined, { mode: 'danger-full-access' }] as const)('preserves unrestricted execution without sandbox dependencies (%j)', async config => {
    const result = create(config).execute('hello');
    await vi.advanceTimersByTimeAsync(1000);
    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--permission-mode');
    expect(args).not.toContain('--settings');
    child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', subtype: 'success' }) + '\n'));
    await expect(result).resolves.toMatchObject({ success: true });
  });
});
