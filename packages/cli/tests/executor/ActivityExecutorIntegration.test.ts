import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { CodexAppServerExecutor } from '../../src/executor/CodexAppServerExecutor';
import { OpenCodeExecutor } from '../../src/executor/OpenCodeExecutor';
import { KimiExecutor } from '../../src/executor/KimiExecutor';
import { PiExecutor } from '../../src/executor/PiExecutor';
import { AgyExecutor } from '../../src/executor/AgyExecutor';
import { ClaudePersistentExecutor } from '../../src/executor/ClaudePersistentExecutor';
import type { AcpEventCallbacks, AcpTransport } from '../../src/executor/acp/AcpClient';
import type { AcpContentBlock, AcpSessionResult } from '../../src/executor/acp/AcpTypes';
import type { PiLaunchOptions, PiRpcResponse, PiTransport } from '../../src/executor/pi/PiTypes';
import type { ActivityProgressInfo } from '../../src/types';

// Mock child_process for AGY tests
vi.mock('child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

import { spawn } from 'child_process';
import { EventEmitter } from 'events';

class FakeAcpTransport implements AcpTransport {
  initialize = vi.fn().mockResolvedValue({});
  newSession = vi.fn(async (): Promise<AcpSessionResult> => ({ sessionId: 'acp-session', configOptions: [] }));
  loadSession = vi.fn(async (): Promise<AcpSessionResult> => ({ configOptions: [] }));
  prompt = vi.fn(async (_id: string, _blocks: AcpContentBlock[]) => ({ stopReason: 'end_turn' }));
  setConfigOption = vi.fn().mockResolvedValue({ configOptions: [] });
  deleteSession = vi.fn().mockResolvedValue(undefined);
  sendCancel = vi.fn();
  destroy = vi.fn();
  waitForExit = vi.fn().mockResolvedValue(undefined);
}

class FakePiTransport implements PiTransport {
  running = false;
  starts = 0;
  launch: PiLaunchOptions;
  events = new Set<(event: Record<string, any>) => void>();
  request = vi.fn(async (_cmd: Record<string, unknown>): Promise<PiRpcResponse> => ({
    type: 'response',
    success: true,
  }));
  updateLaunch = vi.fn();

  constructor(launch: PiLaunchOptions) {
    this.launch = launch;
  }

  async start(): Promise<void> {
    this.running = true;
    this.starts++;
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  onEvent(handler: (event: Record<string, any>) => void): () => void {
    this.events.add(handler);
    return () => this.events.delete(handler);
  }

  emit(event: Record<string, any>): void {
    for (const handler of this.events) handler(event);
  }
}

class FakeCodexTransport {
  requests: any[] = [];
  listeners: ((msg: any) => void)[] = [];
  running = false;
  nextThreadId = 'codex-thread-1';
  nextTurnId = 'turn-1';

  async start() {
    this.running = true;
  }
  async stop() {
    this.running = false;
  }
  isRunning() {
    return this.running;
  }
  setWorkingDirectory() {}
  onMessage(listener: (msg: any) => void) {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }
  emit(msg: any) {
    for (const listener of this.listeners) listener(msg);
  }
  async request(method: string, params: any) {
    this.requests.push({ method, params });
    if (method === 'thread/start') return { thread: { id: this.nextThreadId } };
    if (method === 'thread/resume') return { thread: { id: params?.threadId ?? this.nextThreadId } };
    if (method === 'turn/start') return { turn: { id: this.nextTurnId, status: 'inProgress' } };
    return {};
  }
  respond = vi.fn();
  respondError = vi.fn();
}

describe('Executor Activity Signal Integration', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'remote-cli-activity-test-')));
    vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('CodexAppServerExecutor', () => {
    it('emits commentary in agentMessage/delta but skips final_answer', async () => {
      const transport = new FakeCodexTransport();
      const executor = new CodexAppServerExecutor(new DirectoryGuard([tempDir]), {
        initialWorkingDirectory: tempDir,
        threadId: 'test-codex',
        clientFactory: () => transport as any,
      });

      const activities: ActivityProgressInfo[] = [];
      const streamChunks: string[] = [];

      const resultPromise = executor.execute('Run task', {
        onActivity: (a) => activities.push(a),
        onStream: (chunk) => streamChunks.push(chunk),
      });

      await vi.waitFor(() => expect(transport.requests.some((r) => r.method === 'turn/start')).toBe(true));

      // 1. Commentary message
      transport.emit({
        method: 'item/started',
        params: { turnId: 'turn-1', item: { id: 'item-commentary', type: 'agentMessage', phase: 'commentary' } },
      });
      transport.emit({
        method: 'item/agentMessage/delta',
        params: { turnId: 'turn-1', itemId: 'item-commentary', delta: 'I am reading configuration files' },
      });
      transport.emit({
        method: 'item/completed',
        params: { turnId: 'turn-1', item: { id: 'item-commentary', type: 'agentMessage' } },
      });

      // 2. Final answer message (must be skipped from onActivity!)
      transport.emit({
        method: 'item/started',
        params: { turnId: 'turn-1', item: { id: 'item-final', type: 'agentMessage', phase: 'final_answer' } },
      });
      transport.emit({
        method: 'item/agentMessage/delta',
        params: { turnId: 'turn-1', itemId: 'item-final', phase: 'commentary', delta: 'The final answer is 42.' },
      });
      transport.emit({
        method: 'item/completed',
        params: { turnId: 'turn-1', item: { id: 'item-final', type: 'agentMessage' } },
      });

      transport.emit({
        method: 'turn/completed',
        params: { turn: { id: 'turn-1', status: 'completed' } },
      });

      const result = await resultPromise;
      expect(result.success).toBe(true);

      // Verify stream received both
      expect(streamChunks).toEqual(['I am reading configuration files', 'The final answer is 42.']);

      // Verify onActivity only received the commentary, NOT final_answer!
      expect(activities).toHaveLength(1);
      expect(activities[0]).toEqual({
        source: 'public_text',
        text: 'I am reading configuration files',
      });

      await executor.destroy();
    });

    it('emits public reasoning summaries separated by itemId and excludes them from final output', async () => {
      const transport = new FakeCodexTransport();
      const executor = new CodexAppServerExecutor(new DirectoryGuard([tempDir]), {
        initialWorkingDirectory: tempDir,
        threadId: 'test-codex-reasoning',
        clientFactory: () => transport as any,
      });

      const activities: ActivityProgressInfo[] = [];
      const streamChunks: string[] = [];

      const resultPromise = executor.execute('Think about architecture', {
        onActivity: (a) => activities.push(a),
        onStream: (chunk) => streamChunks.push(chunk),
      });

      await vi.waitFor(() => expect(transport.requests.some((r) => r.method === 'turn/start')).toBe(true));

      // Item 1 reasoning
      transport.emit({
        method: 'item/reasoning/summaryTextDelta',
        params: { turnId: 'turn-1', itemId: 'r1', summaryIndex: 0, delta: 'Checking database schema' },
      });
      // Item 2 reasoning
      transport.emit({
        method: 'item/reasoning/summaryTextDelta',
        params: { turnId: 'turn-1', itemId: 'r2', summaryIndex: 0, delta: 'Validating migrations' },
      });

      // Final prose
      transport.emit({
        method: 'item/started',
        params: { turnId: 'turn-1', item: { id: 'final', type: 'agentMessage', phase: 'final_answer' } },
      });
      transport.emit({
        method: 'item/agentMessage/delta',
        params: { turnId: 'turn-1', itemId: 'final', delta: 'Architecture verified.' },
      });
      transport.emit({
        method: 'turn/completed',
        params: { turn: { id: 'turn-1', status: 'completed' } },
      });

      const result = await resultPromise;
      expect(result.success).toBe(true);
      // Reasoning summary MUST NOT enter the final result output
      expect(result.output).toBe('Architecture verified.');
      expect(streamChunks).toEqual(['Architecture verified.']);

      expect(activities).toEqual([
        { source: 'reasoning_summary', text: 'Checking database schema' },
        { source: 'reasoning_summary', text: 'Validating migrations' },
      ]);

      await executor.destroy();
    });

    it('emits current native plan steps and preserves unfinished work when the turn ends', async () => {
      const transport = new FakeCodexTransport();
      const executor = new CodexAppServerExecutor(new DirectoryGuard([tempDir]), {
        initialWorkingDirectory: tempDir, threadId: 'codex-plan', clientFactory: () => transport as any,
      });
      const activities: ActivityProgressInfo[] = [];
      const run = executor.execute('Follow a plan', { onActivity: value => activities.push(value) });
      await vi.waitFor(() => expect(transport.requests.some(request => request.method === 'turn/start')).toBe(true));
      transport.emit({ method: 'turn/plan/updated', params: { turnId: 'turn-1', plan: [
        { status: 'completed', step: 'Already finished' }, { status: 'pending', step: 'Pending verification' },
      ] } });
      transport.emit({ method: 'item/agentMessage/delta', params: {
        turnId: 'turn-1', itemId: 'unknown-phase', phase: 'commentary', delta: 'Unclassified text',
      } });
      transport.emit({ method: 'item/reasoning/textDelta', params: { turnId: 'turn-1', delta: 'PRIVATE_REASONING' } });
      transport.emit({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
      await run;
      expect(activities).toEqual([{ source: 'plan', text: 'Pending verification' }]);
      await executor.destroy();
    });

    it('emits safe command descriptions without leaking raw commands or sensitive arguments', async () => {
      const transport = new FakeCodexTransport();
      const executor = new CodexAppServerExecutor(new DirectoryGuard([tempDir]), {
        initialWorkingDirectory: tempDir,
        threadId: 'test-codex-command',
        clientFactory: () => transport as any,
      });

      const activities: ActivityProgressInfo[] = [];

      const resultPromise = executor.execute('Run command', {
        onActivity: (a) => activities.push(a),
      });

      await vi.waitFor(() => expect(transport.requests.some((r) => r.method === 'turn/start')).toBe(true));

      transport.emit({
        method: 'item/started',
        params: {
          turnId: 'turn-1',
          item: {
            id: 'cmd-1',
            type: 'commandExecution',
            command: 'bash -c "export API_KEY=synthetic_key; curl -s https://example.com"',
            title: 'Fetch remote resource',
          },
        },
      });

      transport.emit({
        method: 'turn/completed',
        params: { turn: { id: 'turn-1', status: 'completed' } },
      });

      await resultPromise;

      expect(activities).toHaveLength(1);
      expect(activities[0]).toEqual({
        source: 'tool',
        text: 'Fetch remote resource',
      });
      expect(activities[0].text).not.toContain('API_KEY');
      expect(activities[0].text).not.toContain('secret_99');

      await executor.destroy();
    });
  });

  describe('AcpExecutor (OpenCode & Kimi)', () => {
    it('emits public text, excludes thoughts, and emits native plan mode and todo tool plans', async () => {
      let callbacks: AcpEventCallbacks = {};
      const transport = new FakeAcpTransport();
      const executor = new OpenCodeExecutor(new DirectoryGuard([tempDir]), {
        initialWorkingDirectory: tempDir,
        threadId: 'test-acp',
        sessionBaseDir: path.join(tempDir, 'sessions'),
        clientFactory: (cb) => {
          callbacks = cb;
          return transport;
        },
      });

      const activities: ActivityProgressInfo[] = [];

      transport.prompt.mockImplementationOnce(async () => {
        // Thoughts must be excluded
        callbacks.onThoughtChunk?.({ type: 'text', text: 'Private reasoning that should never leak' });

        // Public text delta
        callbacks.onTextChunk?.({ type: 'text', text: 'Preparing the test environment' });

        // Native structured plan
        callbacks.onPlan?.([
          { status: 'completed', content: 'Step 1: check files' },
          { status: 'in_progress', content: 'Step 2: run tests' },
          { status: 'pending', content: 'Step 3: report results' },
        ]);

        // Tool with todos mapping to plan
        callbacks.onToolCall?.({
          toolCallId: 'tool-todo-1',
          title: 'update todos',
          kind: 'other',
          rawInput: {
            todos: [
              { status: 'completed', content: 'Old task' },
              { status: 'in_progress', content: 'In-progress task from tool' },
            ],
          },
        });

        // Safe tool description
        callbacks.onToolCall?.({
          toolCallId: 'tool-cmd-1',
          title: 'Run test suite',
          kind: 'execute',
          rawInput: { command: 'npm run test:all --token=secret' },
        });

        return { stopReason: 'end_turn' };
      });

      const result = await executor.execute('Run plan', {
        onActivity: (a) => activities.push(a),
      });

      expect(result.success).toBe(true);

      // Verify thought was excluded
      expect(activities.some((a) => a.text.includes('Private reasoning'))).toBe(false);

      // Verify sequence of activities
      expect(activities).toContainEqual({
        source: 'public_text',
        text: 'Preparing the test environment',
      });
      expect(activities).toContainEqual({
        source: 'plan',
        text: 'Step 2: run tests',
      });
      expect(activities).toContainEqual({
        source: 'plan',
        text: 'In-progress task from tool',
      });
      expect(activities).toContainEqual({
        source: 'tool',
        text: 'Run test suite',
      });

      await executor.destroy();
    });
  });

  describe('AgyExecutor', () => {
    it('emits agent_response text_delta and tool step activity', async () => {
      const mockChild = new EventEmitter() as any;
      mockChild.stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() });
      mockChild.stdout = new EventEmitter();
      mockChild.stderr = new EventEmitter();
      mockChild.kill = vi.fn();
      mockChild.pid = 12345;

      (spawn as any).mockReturnValue(mockChild);

      const threadId = `test-agy-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const executor = new AgyExecutor(new DirectoryGuard([tempDir]), {
        initialWorkingDirectory: tempDir,
        threadId,
      });

      const activities: ActivityProgressInfo[] = [];

      const executePromise = executor.execute('Run task', {
        onActivity: (a) => activities.push(a),
      });

      // Wait a tick for spawn
      await new Promise((r) => setTimeout(r, 20));

      // Simulate agy events
      mockChild.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: 'conv-1' }) + '\n'));
      mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
        event: 'step_update',
        step_update: { step_type: 'agent_response', text_delta: 'Investigating files' },
      }) + '\n'));
      mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
        event: 'step_update',
        step_update: {
          step_type: 'tool',
          step_index: 1,
          state: 'ACTIVE',
          tool_name: 'run_command',
          tool_info: { parameters: { command: 'ls -la' } },
        },
      }) + '\n'));
      mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
        event: 'result',
        result: { status: 'SUCCESS', output: 'Done' },
      }) + '\n'));

      const result = await executePromise;
      if (!result.success) console.log('AgyExecutor test failed with result:', result);
      expect(result.success).toBe(true);

      expect(activities).toEqual([
        { source: 'public_text', text: 'Investigating files' },
        { source: 'tool', text: 'Running command' },
      ]);

      await executor.destroy();
    });
  });

  describe('PiExecutor', () => {
    it('emits text_delta and excludes private thoughts', async () => {
      let transport: FakePiTransport;
      const executor = new PiExecutor(new DirectoryGuard([tempDir]), {
        initialWorkingDirectory: tempDir,
        threadId: 'test-pi',
        clientFactory: (launch) => {
          transport = new FakePiTransport(launch);
          transport.request = vi.fn(async (command: Record<string, unknown>): Promise<PiRpcResponse> => {
            if (command.type === 'prompt') {
              transport.emit({ type: 'agent_start' });
              transport.emit({
                type: 'message_update',
                assistantMessageEvent: { type: 'text_delta', delta: 'Computing solution' },
              });
              // Private thought should not be text_delta and must not emit activity
              transport.emit({
                type: 'message_update',
                assistantMessageEvent: { type: 'thought_delta', delta: 'secret inner thoughts' },
              });
              transport.emit({
                type: 'tool_execution_start',
                toolCallId: 't1',
                toolName: 'read_file',
                args: { path: 'README.md' },
              });
              transport.emit({ type: 'agent_settled' });
              return { type: 'response', command: 'prompt', success: true };
            }
            return { type: 'response', success: true };
          });
          return transport;
        },
      });

      const activities: ActivityProgressInfo[] = [];

      const result = await executor.execute('Hello Pi', {
        onActivity: (a) => activities.push(a),
      });

      expect(result.success).toBe(true);
      expect(activities.some((a) => a.text.includes('secret inner thoughts'))).toBe(false);
      expect(activities).toContainEqual({
        source: 'public_text',
        text: 'Computing solution',
      });
      expect(activities).toContainEqual({
        source: 'tool',
        text: 'Reading file',
      });

      await executor.destroy();
    });
  });

  describe('ClaudePersistentExecutor', () => {
    it('emits public text and safe tool activity but excludes thinking and redacted_thinking', async () => {
      const mockChild = new EventEmitter() as any;
      mockChild.stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() });
      mockChild.stdout = new EventEmitter();
      mockChild.stderr = new EventEmitter();
      mockChild.kill = vi.fn();
      mockChild.pid = 23456;

      (spawn as any).mockReturnValue(mockChild);

      const executor = new ClaudePersistentExecutor(new DirectoryGuard([tempDir]), tempDir);

      const activities: ActivityProgressInfo[] = [];

      const executePromise = executor.execute('Run claude task', {
        onActivity: (a) => activities.push(a),
      });

      await vi.waitFor(() => expect(mockChild.stdin.write).toHaveBeenCalled(), { timeout: 3000 });

      const emit = (obj: any) => mockChild.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n'));

      // 1. Init
      emit({ type: 'system', subtype: 'init', session_id: 'claude-session-1' });

      // 2. Stream event with thinking (must be excluded)
      emit({
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { id: 'msg-1' },
        },
      });
      emit({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking' },
        },
      });
      emit({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'internal hidden reasoning' },
        },
      });

      // 3. Stream event with public text delta
      emit({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'text', text: '' },
        },
      });
      emit({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'Analyzing codebase structure' },
        },
      });

      // 4. Redacted thinking assistant message (must be excluded)
      emit({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'redacted_thinking', data: 'encrypted-data' },
          ],
        },
      });

      emit({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'claude-tool-1',
            name: 'Bash',
            input: { command: 'npm test -- --run', description: 'Run unit tests' },
          }],
        },
      });

      // 5. Result
      emit({ type: 'result', subtype: 'success', result: 'Completed task', is_error: false });

      const result = await executePromise;
      mockChild.emit('exit', 0, null);
      mockChild.emit('close', 0, null);

      expect(result.success).toBe(true);

      // Verify thinking / redacted thinking was not emitted as activity
      expect(activities.some((a) => a.text.includes('internal hidden reasoning'))).toBe(false);
      expect(activities.some((a) => a.text.includes('encrypted-data'))).toBe(false);

      // Verify public text delta was emitted
      expect(activities).toEqual([
        { source: 'public_text', text: 'Analyzing codebase structure' },
        { source: 'tool', text: 'Run unit tests' },
      ]);
      expect(activities.some((a) => a.text.includes('npm test -- --run'))).toBe(false);

      await executor.destroy();
    });
  });
});
