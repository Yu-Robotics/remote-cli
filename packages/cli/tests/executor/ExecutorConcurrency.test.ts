import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import osDefault, * as os from 'os';
import * as path from 'path';
import { AgyExecutor } from '../../src/executor/AgyExecutor';
import { ClaudePersistentExecutor } from '../../src/executor/ClaudePersistentExecutor';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import * as fs from 'node:fs/promises';
import { spawn } from 'child_process';

const fixture = vi.hoisted(() => ({ root: '' }));
vi.mock('os', async (importOriginal) => {
  const original = await importOriginal<typeof os>();
  const homedir = () => fixture.root;
  return { ...original, homedir, default: { ...original, homedir } };
});

// Prompts received by agy-format user events (recorded by the stdin mock below)
const agyPrompts: string[] = [];
const claudeInputs: Array<{ message: { content: string }; isSlashCommand?: boolean }> = [];
const claudeControls: Array<{ request: { subtype: string; hooks?: unknown }; respond(): void }> = [];

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
        writable: true,
        write: vi.fn((data: string, callback?: (error?: Error | null) => void) => {
          const parsed = JSON.parse(data);
          callback?.(null);
          if (parsed.type === 'control_request') {
            const response = parsed.request.subtype === 'initialize' ? { models: [] }
              : parsed.request.subtype === 'get_settings' ? { effective: { env: { TZ: 'UTC' } } }
                : undefined;
            if (!response) throw new Error('Unexpected Claude control request in concurrency fixture.');
            // Tests release each handshake stage explicitly; controls are never turn completions.
            claudeControls.push({ request: parsed.request, respond: () => {
              if (!closed) child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'control_response', response: {
                subtype: 'success', request_id: parsed.request_id, response,
              } }) + '\n'));
            } });
            return true;
          }
          if (parsed.event === 'user') agyPrompts.push(parsed.message?.content ?? '');
          else if (parsed.type === 'user') claudeInputs.push(parsed);
          else throw new Error('Unexpected input in concurrency fixture.');
          setTimeout(() => {
            if (closed) return;
            const result = parsed.type === 'user' ? { type: 'result', subtype: 'success',
              user_message_uuid: parsed.uuid, is_error: false, terminal_reason: 'completed', result: 'ok' }
              : { event: 'result', result: {
              conversation_id: '', status: 'SUCCESS', response: 'ok', duration_seconds: 0, num_turns: 1, usage: {},
            } };
            child.stdout.emit('data', Buffer.from(JSON.stringify(result) + '\n'));
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

  beforeEach(async () => {
    vi.clearAllMocks();
    agyPrompts.length = 0;
    claudeInputs.length = 0;
    claudeControls.length = 0;
    fixture.root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'executor-concurrency-')));
    vi.stubEnv('HOME', fixture.root);
    vi.stubEnv('USERPROFILE', fixture.root);
    expect(os.homedir()).toBe(fixture.root);
    expect(osDefault.homedir()).toBe(fixture.root);
    directoryGuard = new DirectoryGuard([fixture.root]);
  });

  afterEach(async () => {
    if (vi.isFakeTimers()) { vi.clearAllTimers(); vi.useRealTimers(); }
    vi.unstubAllEnvs();
    await fs.rm(fixture.root, { recursive: true, force: true });
  });

  describe('AgyExecutor', () => {
    it('should queue multiple execute calls sequentially', async () => {
      const executor = new AgyExecutor(directoryGuard, { initialWorkingDirectory: fixture.root });

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
      const executor = new AgyExecutor(directoryGuard, { initialWorkingDirectory: fixture.root });

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
    it('fences reset-interrupted startup and admits only a fresh explicit retry', async () => {
      const executor = new ClaudePersistentExecutor(directoryGuard, fixture.root, 'synthetic-thread', undefined, undefined, 'synthetic-claude', false);
      
      const p1 = executor.execute('First command', {});
      executor.resetContext();
      const p2 = executor.execute('Second command', {});
      
      try {
        const [interrupted, blocked] = await Promise.all([p1, p2]);
        expect(interrupted).toEqual({ success: false, error: 'Claude startup was cancelled after process creation' });
        expect(blocked).toEqual({ success: false, error: 'Native cleanup is still pending. Retry after cleanup.' });
        expect(claudeInputs).toEqual([]);
        expect(executor.hasUncertainShutdown()).toBe(false);
        expect(executor.isBusy()).toBe(false);
        // Reset is destructive, not a request to replay pre-reset prompts in a new conversation.
        expect((await executor.execute('Fresh explicit retry')).success).toBe(true);
        expect(claudeInputs.map(input => input.message.content)).toEqual(['Fresh explicit retry']);
      } finally {
        await executor.destroy();
      }
    });
    
    it.each([false, true])('should queue multiple slash commands and regular commands (managed tools: %s)', async managed => {
      vi.useFakeTimers();
      const executor = new ClaudePersistentExecutor(directoryGuard, fixture.root, 'synthetic-thread', undefined, undefined, 'synthetic-claude', false);
      (executor as any).sessionId = 'test-session';
      if (managed) await executor.configureManagedTools({ url: 'http://127.0.0.1:12345/', token: 'synthetic-token', groups: ['scheduling'] });

      // Sending multiple commands rapidly
      const p1 = executor.execute('/clear', { }); // Assuming we could pass it as prompt
      const p2 = executor.execute('normal prompt', { });
      const p3 = executor.compact();
      const completed: number[] = [];
      const pending = [p1, p2, p3].map((promise, index) => promise.then(result => { completed.push(index); return result; }));
      const drained = Promise.allSettled(pending);
      try {
        await vi.advanceTimersByTimeAsync(1000);
        expect(spawn).toHaveBeenCalledTimes(1);
        const args = vi.mocked(spawn).mock.calls[0][1] as string[];
        expect(args.includes('--await-initialize')).toBe(managed);
        expect(claudeControls.map(control => control.request.subtype)).toEqual(['initialize']);
        expect(claudeControls[0].request.hooks).toEqual(expect.objectContaining({
          PreToolUse: expect.any(Array), UserPromptSubmit: expect.any(Array),
        }));
        expect(claudeInputs).toEqual([]);
        expect(completed).toEqual([]);

        claudeControls[0].respond();
        await vi.advanceTimersByTimeAsync(0);
        expect(claudeControls.map(control => control.request.subtype)).toEqual(['initialize', 'get_settings']);
        expect(claudeInputs).toEqual([]);
        expect(completed).toEqual([]);

        claudeControls[1].respond();
        await vi.advanceTimersByTimeAsync(0);
        expect(claudeInputs.map(input => input.message.content)).toEqual(['/clear']);
        for (let index = 0; index < 3; index++) {
          await vi.advanceTimersByTimeAsync(10);
          expect(completed).toEqual(Array.from({ length: index + 1 }, (_, value) => value));
          expect(claudeInputs).toHaveLength(Math.min(index + 2, 3));
        }
        const results = await Promise.all(pending);
        expect(results.every(result => result.success)).toBe(true);
        expect(claudeInputs.map(input => input.message.content)).toEqual(['/clear', 'normal prompt', '/compact']);
        expect(claudeInputs[2].isSlashCommand).toBe(true);
        expect(executor.isBusy()).toBe(false);
        expect(spawn).toHaveBeenCalledTimes(1);
      } finally {
        const cleanup = executor.destroy();
        void cleanup.catch(() => undefined);
        try {
          await vi.advanceTimersByTimeAsync(1000);
          await cleanup;
        } finally {
          await drained;
        }
      }
    });
  });
});
