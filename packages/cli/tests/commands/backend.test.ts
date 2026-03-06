import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MessageHandler } from '../../src/client/MessageHandler';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';

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

  beforeEach(() => {
    vi.clearAllMocks();

    mockWsClient = {
      send: vi.fn(),
      isConnected: vi.fn(() => true),
    };

    mockExecutor = {
      execute: vi.fn(),
      setWorkingDirectory: vi.fn(),
      getCurrentWorkingDirectory: vi.fn(() => '/home/user/project'),
      resetContext: vi.fn(),
      abort: vi.fn().mockResolvedValue(false),
      destroy: vi.fn(),
    };

    mockConfig = {
      get: vi.fn().mockReturnValue(undefined), // no executor config by default
      set: vi.fn().mockResolvedValue(undefined),
    };

    const guard = new DirectoryGuard(['~/project']);
    handler = new MessageHandler(mockWsClient as any, mockExecutor, guard, mockConfig as any);
  });

  afterEach(() => {
    handler.destroy();
  });

  function sentResponse() {
    const calls = mockWsClient.send.mock.calls;
    return calls.find((c) => c[0].type === 'response')?.[0] ?? null;
  }

  async function send(content: string) {
    await handler.handleMessage({
      type: 'command',
      messageId: 'msg-1',
      content,
      timestamp: Date.now(),
    });
  }

  // ── list mode ────────────────────────────────────────────────────────────────

  describe('list mode (/backend with no args)', () => {
    it('shows installed backends with active marker', async () => {
      mockInstalled('claude', 'npx');
      mockConfig.get.mockReturnValue({ type: 'auto' });

      await send('/backend');

      const res = sentResponse();
      expect(res.success).toBe(true);
      expect(res.output).toContain('Claude Code');
      expect(res.output).toContain('★ (active)');
      expect(res.output).toContain('Gemini CLI');
    });

    it('shows only Claude when Gemini is not installed', async () => {
      mockInstalled('claude');

      await send('/backend');

      const res = sentResponse();
      expect(res.success).toBe(true);
      expect(res.output).toContain('Claude Code');
      expect(res.output).not.toContain('Gemini CLI');
    });

    it('shows only Gemini when Claude is not installed', async () => {
      mockInstalled('npx');

      await send('/backend');

      const res = sentResponse();
      expect(res.success).toBe(true);
      expect(res.output).not.toContain('Claude Code');
      expect(res.output).toContain('Gemini CLI');
    });

    it('returns error when no backends are installed', async () => {
      mockInstalled(); // nothing installed

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

    it('marks Gemini as active when executor.type is gemini', async () => {
      mockInstalled('claude', 'npx');
      mockConfig.get.mockReturnValue({ type: 'gemini' });

      await send('/backend');

      const res = sentResponse();
      // Only Gemini should have the active marker
      const lines = res.output.split('\n');
      const geminiLine = lines.find((l: string) => l.includes('Gemini CLI'));
      const claudeLine = lines.find((l: string) => l.includes('Claude Code'));
      expect(geminiLine).toContain('★ (active)');
      expect(claudeLine).not.toContain('★ (active)');
    });
  });

  // ── switch mode ───────────────────────────────────────────────────────────────

  describe('switch mode (/backend <target>)', () => {
    it('switches to Gemini by 1-based index', async () => {
      mockInstalled('claude', 'npx');

      await send('/backend 2'); // index 2 = Gemini

      const res = sentResponse();
      expect(res.success).toBe(true);
      expect(res.output).toContain('Gemini CLI');
      expect(mockConfig.set).toHaveBeenCalledWith('executor', expect.objectContaining({ type: 'gemini' }));
    });

    it('switches to Claude Code by index', async () => {
      mockInstalled('claude', 'npx');

      await send('/backend 1'); // index 1 = Claude Code

      const res = sentResponse();
      expect(res.success).toBe(true);
      expect(res.output).toContain('Claude Code');
      expect(mockConfig.set).toHaveBeenCalledWith('executor', expect.objectContaining({ type: 'auto' }));
    });

    it('switches by partial label match', async () => {
      mockInstalled('npx');

      await send('/backend gemini');

      const res = sentResponse();
      expect(res.success).toBe(true);
      expect(res.output).toContain('Gemini CLI');
      expect(mockConfig.set).toHaveBeenCalledWith('executor', expect.objectContaining({ type: 'gemini' }));
    });

    it('switches to Claude by name', async () => {
      mockInstalled('claude', 'npx');

      await send('/backend claude');

      const res = sentResponse();
      expect(res.success).toBe(true);
      expect(res.output).toContain('Claude Code');
      expect(mockConfig.set).toHaveBeenCalledWith('executor', expect.objectContaining({ type: 'auto' }));
    });

    it('preserves existing gemini sub-config when switching', async () => {
      mockInstalled('npx');
      mockConfig.get.mockReturnValue({ type: 'auto', gemini: { model: 'gemini-2.5-pro' } });

      await send('/backend gemini');

      expect(mockConfig.set).toHaveBeenCalledWith('executor', {
        type: 'gemini',
        gemini: { model: 'gemini-2.5-pro' },
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
      mockInstalled('claude'); // gemini not installed

      await send('/backend gemini');

      const res = sentResponse();
      expect(res.success).toBe(false);
      expect(res.error).toContain('"gemini" not found');
    });
  });
});
