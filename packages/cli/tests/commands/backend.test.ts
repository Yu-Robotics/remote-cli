import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MessageHandler } from '../../src/client/MessageHandler';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { ThreadExecutorPool } from '../../src/thread/ThreadExecutorPool';
import { ThreadManager } from '../../src/thread/ThreadManager';
import os from 'os';

// Mock os.homedir() to respect process.env.HOME for isolated tests
const originalHomedir = os.homedir();
vi.spyOn(os, 'homedir').mockImplementation(() => process.env.HOME || originalHomedir);

// Mock child_process so we can control which backends appear "installed"
vi.mock('child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('child_process')>();
  return {
    ...original,
    execFile: vi.fn(),
    spawn: vi.fn(() => ({
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
    })),
  };
});

import { execFile } from 'child_process';

/** Helper: make execFile call its callback with no error (command found) or an error (not found) */
function mockInstalled(...installedCmds: string[]) {
  (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
      cb(installedCmds.includes(cmd) ? null : new Error('not found'));
    }
  );
}

describe('/backend command', () => {
  let handler: MessageHandler;
  let mockWsClient: { send: ReturnType<typeof vi.fn>; isConnected: ReturnType<typeof vi.fn> };
  let mockExecutor: any;
  let mockConfig: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };
  let mockThreadPool: any;
  let mockThreadManager: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockWsClient = {
      send: vi.fn(),
      isConnected: vi.fn(() => true),
    };

    mockExecutor = {
      execute: vi.fn(),
      setWorkingDirectory: vi.fn().mockResolvedValue(undefined),
      getCurrentWorkingDirectory: vi.fn(() => '/home/user/project'),
      resetContext: vi.fn(),
      abort: vi.fn().mockResolvedValue(false),
      destroy: vi.fn().mockResolvedValue(undefined),
    };

    mockConfig = {
      get: vi.fn().mockReturnValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
      getConfigDir: vi.fn().mockReturnValue('/tmp/.remote-cli'),
    };

    const defaultThread = { id: 'default-id', name: 'default', workingDirectory: '/home/user/project', sessionId: null, createdAt: 0, lastActiveAt: 0 };

    mockThreadManager = {
      getDefaultThread: vi.fn().mockReturnValue(defaultThread),
      getThread: vi.fn().mockImplementation((id: string) => id === defaultThread.id ? defaultThread : undefined),
      getThreadByName: vi.fn().mockImplementation((name: string) => name === 'default' ? defaultThread : undefined),
      listThreads: vi.fn().mockReturnValue([defaultThread]),
      createThread: vi.fn(),
      deleteThread: vi.fn(),
      updateThread: vi.fn().mockImplementation(async (_id: string, updates: any) => ({ ...defaultThread, ...updates })),
      getSessionFilePath: vi.fn().mockReturnValue('/tmp/session.jsonl'),
    } as unknown as ThreadManager;

    mockThreadPool = {
      getExecutor: vi.fn().mockReturnValue(mockExecutor),
      isThreadBusy: vi.fn().mockReturnValue(false),
      setThreadBusy: vi.fn(),
      setThreadError: vi.fn(),
      getStatus: vi.fn().mockReturnValue('idle'),
      getSummaries: vi.fn().mockReturnValue([{ id: defaultThread.id, name: 'default', status: 'idle' }]),
      destroyThread: vi.fn().mockResolvedValue(undefined),
      destroyAll: vi.fn().mockResolvedValue(undefined),
      switchBackend: vi.fn().mockResolvedValue(undefined),
    } as unknown as ThreadExecutorPool;

    const guard = new DirectoryGuard(['~/project']);
    handler = new MessageHandler(mockWsClient as any, mockThreadPool, mockThreadManager, guard, mockConfig as any);
  });

  afterEach(async () => {
    await handler.destroy();
  });

  function sentResponse() {
    const calls = mockWsClient.send.mock.calls;
    return calls.find((c) => c[0].type === 'response')?.[0] ?? null;
  }

  async function send(content: string) {
    await handler.handleMessage({ type: 'command', messageId: 'msg-1', content, timestamp: Date.now() });
  }

  // ── list mode ────────────────────────────────────────────────────────────────

  describe('list mode (/backend with no args)', () => {
    it('shows installed backends with active marker', async () => {
      mockInstalled('claude', 'agy');
      mockConfig.get.mockReturnValue({ type: 'auto' });

      await send('/backend');

      const res = sentResponse();
      expect(res.success).toBe(true);
      expect(res.output).toContain('Claude Code');
      expect(res.output).toContain('★ (active)');
      expect(res.output).toContain('AGY CLI');
    });

    it('shows only Claude when AGY is not installed', async () => {
      mockInstalled('claude');

      await send('/backend');

      const res = sentResponse();
      expect(res.success).toBe(true);
      expect(res.output).toContain('Claude Code');
      expect(res.output).not.toContain('AGY CLI');
    });

    it('shows only AGY when Claude is not installed', async () => {
      mockInstalled('agy');

      await send('/backend');

      const res = sentResponse();
      expect(res.success).toBe(true);
      expect(res.output).not.toContain('Claude Code');
      expect(res.output).toContain('AGY CLI');
    });

    it('returns error when no backends are installed', async () => {
      mockInstalled();

      await send('/backend');

      const res = sentResponse();
      expect(res.success).toBe(false);
      expect(res.error).toContain('No supported AI backends found');
    });

    it('marks Claude Code as active when executor.type is auto', async () => {
      mockInstalled('claude');
      mockConfig.get.mockReturnValue({ type: 'auto' });

      await send('/backend');

      const res = sentResponse();
      expect(res.output).toContain('★ (active)');
    });

    it('marks Claude Code as active when executor.type is claude-persistent', async () => {
      mockInstalled('claude');
      mockConfig.get.mockReturnValue({ type: 'claude-persistent' });

      await send('/backend');

      const res = sentResponse();
      expect(res.output).toContain('★ (active)');
    });

    it('marks Claude Code as active when executor.type is claude-spawn', async () => {
      mockInstalled('claude');
      mockConfig.get.mockReturnValue({ type: 'claude-spawn' });

      await send('/backend');

      const res = sentResponse();
      expect(res.output).toContain('★ (active)');
    });

    it('marks AGY as active when executor.type is agy', async () => {
      mockInstalled('claude', 'agy');
      mockConfig.get.mockReturnValue({ type: 'agy' });

      await send('/backend');

      const res = sentResponse();
      const lines = res.output.split('\n');
      const agyLine = lines.find((l: string) => l.includes('AGY CLI'));
      const claudeLine = lines.find((l: string) => l.includes('Claude Code'));
      expect(agyLine).toContain('★ (active)');
      expect(claudeLine).not.toContain('★ (active)');
    });

    it('marks AGY as active for legacy configs with executor.type gemini (index slot migration)', async () => {
      mockInstalled('claude', 'agy');
      // Configs written before the Gemini→AGY migration still say 'gemini';
      // that slot now means AGY.
      mockConfig.get.mockReturnValue({ type: 'gemini' });

      await send('/backend');

      const res = sentResponse();
      const lines = res.output.split('\n');
      const agyLine = lines.find((l: string) => l.includes('AGY CLI'));
      expect(agyLine).toContain('★ (active)');
    });

    it('shows Codex CLI when codex is installed', async () => {
      mockInstalled('claude', 'agy', 'codex');

      await send('/backend');

      const res = sentResponse();
      expect(res.success).toBe(true);
      expect(res.output).toContain('Codex CLI');
    });

    it('marks Codex as active when executor.type is codex', async () => {
      mockInstalled('claude', 'agy', 'codex');
      mockConfig.get.mockReturnValue({ type: 'codex' });

      await send('/backend');

      const res = sentResponse();
      const lines = res.output.split('\n');
      const codexLine = lines.find((l: string) => l.includes('Codex CLI'));
      const claudeLine = lines.find((l: string) => l.includes('Claude Code'));
      expect(codexLine).toContain('★ (active)');
      expect(claudeLine).not.toContain('★ (active)');
    });
  });

  // ── switch mode ───────────────────────────────────────────────────────────────

  describe('switch mode (/backend <target>)', () => {
    it('switches to AGY by 1-based index and swaps all thread executors', async () => {
      mockInstalled('claude', 'agy');

      await send('/backend 2'); // index 2 = AGY

      const res = sentResponse();
      expect(res.success).toBe(true);
      expect(res.output).toContain('AGY CLI');
      expect(mockConfig.set).toHaveBeenCalledWith('executor', expect.objectContaining({ type: 'agy' }));
      expect(mockThreadPool.switchBackend).toHaveBeenCalledWith(expect.objectContaining({ type: 'agy' }));
    });

    it('switches to Claude Code by index', async () => {
      mockInstalled('claude', 'agy');

      await send('/backend 1'); // index 1 = Claude Code

      const res = sentResponse();
      expect(res.success).toBe(true);
      expect(res.output).toContain('Claude Code');
      expect(mockConfig.set).toHaveBeenCalledWith('executor', expect.objectContaining({ type: 'auto' }));
    });

    it('switches by partial label match', async () => {
      mockInstalled('agy');

      await send('/backend agy');

      const res = sentResponse();
      expect(res.success).toBe(true);
      expect(res.output).toContain('AGY CLI');
      expect(mockConfig.set).toHaveBeenCalledWith('executor', expect.objectContaining({ type: 'agy' }));
    });

    it('switches to Claude by name', async () => {
      mockInstalled('claude', 'agy');

      await send('/backend claude');

      const res = sentResponse();
      expect(res.success).toBe(true);
      expect(res.output).toContain('Claude Code');
      expect(mockConfig.set).toHaveBeenCalledWith('executor', expect.objectContaining({ type: 'auto' }));
    });

    it('preserves existing agy sub-config when switching', async () => {
      mockInstalled('agy');
      mockConfig.get.mockReturnValue({ type: 'auto', agy: { model: 'gemini-3-pro' } });

      await send('/backend agy');

      expect(mockConfig.set).toHaveBeenCalledWith('executor', {
        type: 'agy',
        agy: { model: 'gemini-3-pro' },
      });
    });

    it('returns error for unknown backend name', async () => {
      mockInstalled('claude');

      await send('/backend openai');

      const res = sentResponse();
      expect(res.success).toBe(false);
      expect(res.error).toContain('"openai" not found');
    });

    it('returns error for out-of-range index', async () => {
      mockInstalled('claude');

      await send('/backend 99');

      const res = sentResponse();
      expect(res.success).toBe(false);
      expect(res.error).toContain('"99" not found');
    });

    it('returns error when target backend is not installed', async () => {
      mockInstalled('claude'); // agy not installed

      await send('/backend agy');

      const res = sentResponse();
      expect(res.success).toBe(false);
      expect(res.error).toContain('"agy" not found');
    });

    it('switches to Codex by 1-based index (third slot)', async () => {
      mockInstalled('claude', 'agy', 'codex');

      await send('/backend 3'); // index 3 = Codex

      const res = sentResponse();
      expect(res.success).toBe(true);
      expect(res.output).toContain('Codex CLI');
      expect(mockConfig.set).toHaveBeenCalledWith('executor', expect.objectContaining({ type: 'codex' }));
      expect(mockThreadPool.switchBackend).toHaveBeenCalledWith(expect.objectContaining({ type: 'codex' }));
    });

    it('switches to Codex by name', async () => {
      mockInstalled('claude', 'codex');

      await send('/backend codex');

      const res = sentResponse();
      expect(res.success).toBe(true);
      expect(res.output).toContain('Codex CLI');
      expect(mockConfig.set).toHaveBeenCalledWith('executor', expect.objectContaining({ type: 'codex' }));
    });

    it('preserves existing codex sub-config when switching', async () => {
      mockInstalled('codex');
      mockConfig.get.mockReturnValue({ type: 'auto', codex: { model: 'gpt-5.2-codex' } });

      await send('/backend codex');

      expect(mockConfig.set).toHaveBeenCalledWith('executor', {
        type: 'codex',
        codex: { model: 'gpt-5.2-codex' },
      });
    });
  });
});
