import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createClaudeExecutor, ExecutorType } from '../src/executor/index';
import { DirectoryGuard } from '../src/security/DirectoryGuard';
import { ClaudeExecutor } from '../src/executor/ClaudeExecutor';
import { ClaudePersistentExecutor } from '../src/executor/ClaudePersistentExecutor';

// Mock fs module
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    readFileSync: vi.fn().mockReturnValue(''),
  };
});

describe('executor/index', () => {
  let directoryGuard: DirectoryGuard;
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment
    process.env = { ...originalEnv };
    delete process.env.CLAUDECODE;
    delete process.env.CLAUDE_CODE;

    // Create a mock directory guard
    directoryGuard = new DirectoryGuard(['/home/test/workspace']);

    // Mock console.log to avoid noise
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe('createClaudeExecutor', () => {
    describe('with type = spawn', () => {
      it('should return ClaudeExecutor instance', () => {
        const executor = createClaudeExecutor(directoryGuard, 'spawn');
        expect(executor).toBeInstanceOf(ClaudeExecutor);
      });
    });

    describe('with type = persistent', () => {
      it('should return ClaudePersistentExecutor instance', () => {
        const executor = createClaudeExecutor(directoryGuard, 'persistent');
        expect(executor).toBeInstanceOf(ClaudePersistentExecutor);
      });
    });

    describe('with type = auto', () => {
      it('should return ClaudeExecutor when CLAUDECODE env is set', () => {
        process.env.CLAUDECODE = '1';
        const executor = createClaudeExecutor(directoryGuard, 'auto');
        expect(executor).toBeInstanceOf(ClaudeExecutor);
        expect(console.log).toHaveBeenCalledWith(
          '[ExecutorFactory] Detected nested Claude Code session, using spawn mode'
        );
      });

      it('should return ClaudeExecutor when CLAUDE_CODE env is set', () => {
        process.env.CLAUDE_CODE = '1';
        const executor = createClaudeExecutor(directoryGuard, 'auto');
        expect(executor).toBeInstanceOf(ClaudeExecutor);
        expect(console.log).toHaveBeenCalledWith(
          '[ExecutorFactory] Detected nested Claude Code session, using spawn mode'
        );
      });

      it('should return ClaudePersistentExecutor when not inside Claude Code', () => {
        // Neither CLAUDECODE nor CLAUDE_CODE is set
        const executor = createClaudeExecutor(directoryGuard, 'auto');
        expect(executor).toBeInstanceOf(ClaudePersistentExecutor);
        expect(console.log).toHaveBeenCalledWith(
          '[ExecutorFactory] Using persistent mode for better performance'
        );
      });
    });

    describe('default behavior', () => {
      it('should default to auto mode when type is not specified', () => {
        // When not inside Claude Code, default should use persistent mode
        const executor = createClaudeExecutor(directoryGuard);
        expect(executor).toBeInstanceOf(ClaudePersistentExecutor);
      });

      it('should detect nested Claude Code session with default type', () => {
        process.env.CLAUDECODE = '1';
        const executor = createClaudeExecutor(directoryGuard);
        expect(executor).toBeInstanceOf(ClaudeExecutor);
      });
    });

    describe('environment detection', () => {
      it('should handle CLAUDECODE with various truthy values', () => {
        process.env.CLAUDECODE = 'true';
        const executor = createClaudeExecutor(directoryGuard, 'auto');
        expect(executor).toBeInstanceOf(ClaudeExecutor);
      });

      it('should handle empty CLAUDECODE as falsy', () => {
        process.env.CLAUDECODE = '';
        const executor = createClaudeExecutor(directoryGuard, 'auto');
        expect(executor).toBeInstanceOf(ClaudePersistentExecutor);
      });
    });
  });

  describe('type exports', () => {
    it('should export ExecutorType', () => {
      const types: ExecutorType[] = ['persistent', 'spawn', 'auto'];
      expect(types).toHaveLength(3);
    });
  });
});
