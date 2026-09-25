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
const claudeInputs: Array<{ message: { content: string }; isSlashCommand?: boolean }> = [];

// Mock child_process for ClaudePersistentExecutor and AgyExecutor
vi.mock('child_process', () => {
  const { EventEmitter } = require('events') as typeof import('events');
  return {
    spawn: vi.fn().mockImplementation((_command: string, args: string[] = []) => {
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 12345;
      child.killed = false;
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        child.emit('close', 0, null);
      };
      child.stdin = {
        write: vi.fn((data: string) => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.event === 'user') agyPrompts.push(parsed.message?.content ?? '');
            if (parsed.type === 'user') claudeInputs.push(parsed);
          } catch { /* Not a user event. */ }
          setTimeout(() => {
            if (closed) return;
            child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', subtype: 'success' }) + '\n'));
            child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'result', result: {
              conversation_id: '', status: 'SUCCESS', response: 'ok', duration_seconds: 0, num_turns: 1, usage: {},
            } }) + '\n'));
          }, 10);
          return true;
        }),
        end: vi.fn(() => setTimeout(close, 10)),
        on: vi.fn(),
      };
      child.kill = vi.fn(() => { child.killed = true; setTimeout(close, 10); });
      setTimeout(() => child.emit('spawn'), 5);
      // Persistent stream-json processes stay alive until EOF or a signal.
      if (args.includes('-p') || args.includes('--print')) setTimeout(close, 50);
      return child;
    }),
  };
});

describe('Executor Concurrency & Rapid Commands', () => {
  let directoryGuard: DirectoryGuard;

  beforeEach(() => {
    vi.clearAllMocks();
    agyPrompts.length = 0;
    claudeInputs.length = 0;
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
      
      const results = await Promise.all([p1, p2]);
      expect(results.every(result => result.success)).toBe(true);
      expect(claudeInputs.map(input => input.message.content)).toEqual(['First command', 'Second command']);
      await executor.destroy();
    });
    
    it('should queue multiple slash commands and regular commands', async () => {
      const executor = new ClaudePersistentExecutor(directoryGuard);
      (executor as any).sessionId = 'test-session';
      
      // Sending multiple commands rapidly
      const p1 = executor.execute('/clear', { }); // Assuming we could pass it as prompt
      const p2 = executor.execute('normal prompt', { });
      const p3 = executor.compact();
      
      const results = await Promise.all([p1, p2, p3]);
      expect(results.every(result => result.success)).toBe(true);
      expect(claudeInputs.map(input => input.message.content)).toEqual(['/clear', 'normal prompt', '/compact']);
      expect(claudeInputs[2].isSlashCommand).toBe(true);
      await executor.destroy();
    });
  });
});
