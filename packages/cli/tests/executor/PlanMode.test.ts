import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ClaudePersistentExecutor } from '../../src/executor/ClaudePersistentExecutor';
import type { ExecuteOptions } from '../../src/executor/IExecutor';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';

vi.mock('child_process', () => ({ spawn: vi.fn() }));

describe('Claude plan mode', () => {
  let home: string;
  let executor: ClaudePersistentExecutor;
  let child: EventEmitter;
  let stdout: EventEmitter;
  let write: ReturnType<typeof vi.fn>;
  let pending: Promise<unknown>[];

  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'plan-mode-')));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.useFakeTimers();
    child = new EventEmitter();
    stdout = new EventEmitter();
    write = vi.fn();
    pending = [];
    vi.mocked(spawn).mockReturnValue(Object.assign(child, {
      stdout, stderr: new EventEmitter(), stdin: {
        writable: true, write, end: () => queueMicrotask(() => {
          child.emit('exit', 0, null);
          child.emit('close', 0, null);
        }),
      },
    }) as ChildProcess);
    executor = new ClaudePersistentExecutor(new DirectoryGuard([home]), home);
  });

  afterEach(async () => {
    try {
      await executor.destroy();
      await Promise.all(pending);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  function emit(message: object) {
    stdout.emit('data', Buffer.from(JSON.stringify(message) + '\n'));
  }

  function assistant(...blocks: object[]) {
    for (const block of blocks) emit({ type: 'assistant', message: { content: [block] } });
  }

  const text = (value: string) => ({ type: 'text', text: value });
  const tool = (name: string, id: string, input = {}) => ({ type: 'tool_use', name, id, input });

  async function turn(options: ExecuteOptions, events: () => void) {
    write.mockClear();
    const result = executor.execute('Plan the task', options);
    pending.push(Promise.allSettled([result]));
    await vi.advanceTimersByTimeAsync(1000);
    expect(write).toHaveBeenCalledWith(expect.stringContaining('Plan the task'));
    events();
    emit({ type: 'result', subtype: 'success' });
    await expect(result).resolves.toMatchObject({ success: true });
  }

  it('streams text immediately and publishes only the completed plan and ordinary tool cards', async () => {
    const onStream = vi.fn(), onPlanMode = vi.fn(), onToolUse = vi.fn();
    await turn({ onStream, onPlanMode, onToolUse }, () => {
      assistant(text('Preamble'), tool('EnterPlanMode', 'start'), text('Discarded draft'));
      assistant(tool('EnterPlanMode', 'restart'), text('First step\n'), text('Second step'));
      expect(onStream.mock.calls.flat()).toEqual(['Preamble', 'Discarded draft', 'First step\n', 'Second step']);
      expect(onPlanMode).not.toHaveBeenCalled();
      assistant(tool('ExitPlanMode', 'end'), text('Postscript'), tool('ExitPlanMode', 'empty'));
      assistant(tool('Read', 'read-id', { file_path: 'report.txt' }));
      expect(onPlanMode.mock.calls).toEqual([['First step\nSecond step']]);
      expect(onToolUse.mock.calls).toEqual([[{ name: 'Read', id: 'read-id', input: { file_path: 'report.txt' } }]]);
    });
  });

  it('discards an unfinished plan between turns and permits a turn without a plan callback', async () => {
    const previous = vi.fn(), current = vi.fn();
    await turn({ onPlanMode: previous }, () => {
      assistant(tool('EnterPlanMode', 'start'), text('Unfinished'));
    });
    await turn({ onPlanMode: current }, () => {
      assistant(text('Ordinary reply'), tool('ExitPlanMode', 'stale'));
      assistant(tool('EnterPlanMode', 'empty'), tool('ExitPlanMode', 'end'));
      expect(current).not.toHaveBeenCalled();
      assistant(tool('EnterPlanMode', 'fresh'), text('Current plan'), tool('ExitPlanMode', 'done'));
    });
    await turn({}, () => {
      assistant(tool('EnterPlanMode', 'optional'), text('Another plan'), tool('ExitPlanMode', 'end'));
    });
    expect(previous).not.toHaveBeenCalled();
    expect(current.mock.calls).toEqual([['Current plan']]);
  });

  it('suppresses the exit confirmation pseudo-error and forwards correlated success and error results', async () => {
    const onToolResult = vi.fn();
    await turn({ onToolResult }, () => {
      for (const [id, content, isError] of [
        ['exit-id', 'Exit plan mode?', true], ['read-id', 'File not found', true], ['write-id', 'ok', false],
      ] as const) {
        emit({ type: 'user', message: { role: 'user', content: [
          { type: 'tool_result', tool_use_id: id, content, is_error: isError },
        ] } });
      }
      expect(onToolResult.mock.calls).toEqual([
        [expect.objectContaining({ tool_use_id: 'read-id', content: 'File not found', is_error: true })],
        [expect.objectContaining({ tool_use_id: 'write-id', content: 'ok', is_error: false })],
      ]);
    });
  });
});
