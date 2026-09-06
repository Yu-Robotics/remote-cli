import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { AgyExecutor } from '../../src/executor/AgyExecutor';
import { ClaudePersistentExecutor } from '../../src/executor/ClaudePersistentExecutor';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { ConfigManager } from '../../src/config/ConfigManager';
import { ThreadManager } from '../../src/thread/ThreadManager';
import { ThreadExecutorPool } from '../../src/thread/ThreadExecutorPool';
import { MessageHandler } from '../../src/client/MessageHandler';

// Mock os module
vi.mock('os', async (importOriginal) => {
  const original = await importOriginal<typeof os>();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsSync = require('fs') as typeof import('fs');
  const realTmpDir = fsSync.realpathSync(original.tmpdir());
  return {
    ...original,
    homedir: () => realTmpDir,
    tmpdir: () => realTmpDir,
  };
});

// Prompts received by agy-format user events (recorded by the stdin mock below)
const agyPrompts: string[] = [];

// Mock child_process for ClaudePersistentExecutor and AgyExecutor
vi.mock('child_process', () => {
  return {
    spawn: vi.fn().mockImplementation(() => {
      let closeCallback: any;

      const stdinWrite = vi.fn((data: string) => {
        // Automatically respond to any command to prevent timeouts
        setTimeout(() => {
          if (mockStdoutOn) {
            // Emulate a successful Claude stream JSON response
            mockStdoutOn(Buffer.from(JSON.stringify({
              type: 'result',
              success: true
            }) + '\n'));
            // Emulate a successful agy stream-json response (no conversation_id,
            // so no session file is written). Claude's parser ignores lines
            // without a `type` field, agy's parser ignores lines without `event`.
            mockStdoutOn(Buffer.from(JSON.stringify({
              event: 'result',
              result: { conversation_id: '', status: 'SUCCESS', response: 'ok', duration_seconds: 0, num_turns: 1, usage: {} },
            }) + '\n'));
          }
        }, 10);
        try {
          const parsed = JSON.parse(data);
          if (parsed.event === 'user') agyPrompts.push(parsed.message?.content ?? '');
        } catch { /* not agy input */ }
        return true;
      });
      const stdinEnd = vi.fn();
      
      let isKilled = false;
      const kill = vi.fn(() => {
        isKilled = true;
        if (closeCallback) {
          setTimeout(() => closeCallback(0), 10);
        }
      });
      
      let mockStdoutOn: any;
      const stdout = {
        on: vi.fn((event, cb) => {
          if (event === 'data') mockStdoutOn = cb;
        }),
        once: vi.fn()
      };

      const on = vi.fn((event, cb) => {
        if (event === 'close') {
           closeCallback = cb;
           if (isKilled) {
             setTimeout(() => cb(0), 10);
           }
        }
      });
      const once = vi.fn((event, cb) => {
        if (event === 'spawn') {
           setTimeout(cb, 5);
        }
      });
      const removeListener = vi.fn();
      
      // Auto-close for standalone commands like /compact that don't use stdin
      setTimeout(() => {
        if (closeCallback && !isKilled) {
           closeCallback(0);
        }
      }, 50);

      return {
        stdin: { write: stdinWrite, end: stdinEnd, on: vi.fn() },
        stdout,
        stderr: { on: vi.fn(), once: vi.fn() },
        on,
        once,
        removeListener,
        kill,
        pid: 12345,
      };
    })
  };
});

describe('Executor Concurrency & Rapid Commands', () => {
  let directoryGuard: DirectoryGuard;

  beforeEach(() => {
    vi.clearAllMocks();
    agyPrompts.length = 0;
    directoryGuard = new DirectoryGuard([os.tmpdir()]);
  });

  describe('AgyExecutor', () => {
    it('should queue multiple execute calls sequentially', async () => {
      const executor = new AgyExecutor(directoryGuard);

      const p1 = executor.execute('First', {});
      const p2 = executor.execute('Second', {});
      const p3 = executor.execute('Third', {});

      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

      expect(r1.success).toBe(true);
      expect(r2.success).toBe(true);
      expect(r3.success).toBe(true);

      // All three prompts were sent in order
      expect(agyPrompts).toEqual(['First', 'Second', 'Third']);
      await executor.destroy();
    });

    it('should handle resetContext concurrently with execute', async () => {
      const executor = new AgyExecutor(directoryGuard);

      // Fire execute while immediately resetting context
      const p1 = executor.execute('Long command', {});
      executor.resetContext();

      // It might fail or succeed depending on exact timing, but it shouldn't crash
      const r1 = await p1;
      expect(r1).toBeDefined();
      await executor.destroy();
    });
  });

  describe('ClaudePersistentExecutor', () => {
    it('should handle rapid execute and resetContext', async () => {
      const executor = new ClaudePersistentExecutor(directoryGuard);
      
      const p1 = executor.execute('First command', {});
      executor.resetContext();
      const p2 = executor.execute('Second command', {});
      
      await Promise.all([p1, p2]);
      
      // We expect the executor to not crash, even if p1 fails due to process kill
      expect(true).toBe(true); // just checking it resolves without unhandled rejection
      // no destroy
    });
    
    it('should queue multiple slash commands and regular commands', async () => {
      const executor = new ClaudePersistentExecutor(directoryGuard);
      
      // Sending multiple commands rapidly
      const p1 = executor.execute('/clear', { }); // Assuming we could pass it as prompt
      const p2 = executor.execute('normal prompt', { });
      const p3 = executor.compact();
      
      await Promise.all([p1, p2, p3]);
      // no destroy
    });
  });
});
