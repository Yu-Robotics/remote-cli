import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClaudeExecutor, createExecutor, ExecutorType } from '../src/executor';
import { ClaudePersistentExecutor } from '../src/executor/ClaudePersistentExecutor';
import { CodexAppServerExecutor } from '../src/executor/CodexAppServerExecutor';
import { ZCodeExecutor } from '../src/executor/ZCodeExecutor';
import { PiExecutor } from '../src/executor/PiExecutor';
import { DirectoryGuard } from '../src/security/DirectoryGuard';
import { existsSync } from 'fs';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockImplementation((file) => String(file).includes('codex-sandbox') ? false : actual.existsSync(file)),
    readFileSync: vi.fn().mockReturnValue(''),
  };
});

describe('executor/index', () => {
  let directoryGuard: DirectoryGuard;
  const originalEnv = process.env;

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('fs')>('fs');
    vi.mocked(existsSync).mockImplementation(file => String(file).includes('codex-sandbox') ? false : actual.existsSync(file));
    process.env = { ...originalEnv };
    directoryGuard = new DirectoryGuard(['/home/test/workspace']);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe('createClaudeExecutor', () => {
    it.each<ExecutorType>(['auto', 'persistent'])('uses persistent mode for %s', (type) => {
      expect(createClaudeExecutor(directoryGuard, type)).toBeInstanceOf(ClaudePersistentExecutor);
    });

    it('maps the legacy spawn value to persistent mode', () => {
      expect(createClaudeExecutor(directoryGuard, 'spawn')).toBeInstanceOf(ClaudePersistentExecutor);
      expect(console.warn).toHaveBeenCalledWith(
        '[ExecutorFactory] Claude spawn mode was removed; using persistent mode.'
      );
    });

    it('uses persistent mode inside a Claude Code environment', () => {
      process.env.CLAUDECODE = '1';
      process.env.CLAUDE_CODE = '1';

      expect(createClaudeExecutor(directoryGuard, 'auto')).toBeInstanceOf(ClaudePersistentExecutor);
    });
  });

  describe('createExecutor compatibility', () => {
    it('maps a persisted claude-spawn config to Claude persistent mode', () => {
      const executor = createExecutor(
        directoryGuard,
        { type: 'claude-spawn' } as any,
        '/home/test/workspace',
        'thread-a'
      );

      expect(executor).toBeInstanceOf(ClaudePersistentExecutor);
      expect(console.warn).toHaveBeenCalledWith(
        '[ExecutorFactory] Claude spawn mode was removed; using persistent mode.'
      );
    });

    it('maps a persisted Codex exec config to app-server', async () => {
      const executor = createExecutor(
        directoryGuard,
        { type: 'codex', codex: { transport: 'exec' } } as any,
        '/home/test/workspace',
        'thread-a'
      );

      expect(executor).toBeInstanceOf(CodexAppServerExecutor);
      expect(console.warn).toHaveBeenCalledWith(
        '[ExecutorFactory] Codex exec transport was removed; using app-server.'
      );
      await executor.destroy();
    });

    it('passes sandbox configuration to the Codex executor', async () => {
      const executor = createExecutor(directoryGuard, {
        type: 'codex', codex: { sandbox: { mode: 'read-only', networkAccess: false } },
      });
      expect(executor).toBeInstanceOf(CodexAppServerExecutor);
      expect((executor as CodexAppServerExecutor).getSandboxStatus()).toContain('read-only');
      expect((executor as CodexAppServerExecutor).getSandboxStatus()).toContain('Network: restricted');
      await executor.destroy();
    });

    it('creates the official ZCode app-server executor', async () => {
      const executor = createExecutor(
        directoryGuard,
        { type: 'zcode', zcode: { model: 'GLM-5.3', autoApprove: false } },
        '/home/test/workspace',
        'thread-zcode'
      );

      expect(executor).toBeInstanceOf(ZCodeExecutor);
      await executor.destroy();
    });

    it('creates the Pi RPC executor', async () => {
      const executor = createExecutor(
        directoryGuard,
        { type: 'pi', pi: { model: 'google/gemini-3-flash', autoApprove: false } },
        '/home/test/workspace',
        'thread-pi'
      );

      expect(executor).toBeInstanceOf(PiExecutor);
      await executor.destroy();
    });
  });
});
