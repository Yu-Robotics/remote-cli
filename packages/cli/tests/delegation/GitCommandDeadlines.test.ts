import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { spawn } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHECKPOINT_LIMITS, runGit } from '../../src/delegation/GitCheckpoint';

vi.mock('child_process', () => ({ spawn: vi.fn() }));

describe('delegated Git command deadlines', () => {
  let child: EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; kill: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.useFakeTimers();
    child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn().mockReturnValue(true),
    });
    vi.mocked(spawn).mockReturnValue(child as any);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it.each([
    ['worktree add', ['worktree', 'add', '--detach', '/work/private-checkout', 'private-ref']],
    ['checkout', ['checkout', '--detach', '--no-overwrite-ignore', 'private-ref']],
  ])('allows %s past 15 seconds and drains a timed-out child before rejecting', async (operation, args) => {
    let settled = false;
    const result = runGit('/work/project', args).then(value => { settled = true; return value; }, error => { settled = true; return error; });
    await vi.advanceTimersByTimeAsync(CHECKPOINT_LIMITS.commandMs + 1);
    expect(child.kill).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(CHECKPOINT_LIMITS.checkoutMs - CHECKPOINT_LIMITS.commandMs - 2);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(settled).toBe(false);
    child.emit('close', null);
    const error = await result;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(`Git ${operation} timed out after 120000ms (limit 120000ms)`);
    expect(error.message).not.toMatch(/private-checkout|private-ref/);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['worktree list', ['worktree', 'list', '--porcelain']],
    ['worktree list', ['-c', 'core.quotePath=false', 'worktree', 'list', '--porcelain']],
    ['worktree add', ['-c', 'core.quotePath=false', 'worktree', 'add', '--detach', '/work/private-checkout', 'private-ref']],
    ['worktree list', ['-c', 'core.quotePath=false', '-c', 'core.hooksPath=/work/private-checkout', 'worktree', 'list', '--porcelain']],
    ['worktree remove', ['worktree', 'remove', '/work/private-checkout']],
    ['rev-parse', ['rev-parse', 'HEAD']],
  ])('retains the 15-second deadline for %s', async (operation, args) => {
    const result = runGit('/work/project', args).catch(error => error);
    await vi.advanceTimersByTimeAsync(CHECKPOINT_LIMITS.commandMs - 1);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close', null);
    expect((await result).message).toBe(`Git ${operation} timed out after 15000ms (limit 15000ms)`);
    await vi.advanceTimersByTimeAsync(500);
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts a slow successful checkout and cancels its deadline', async () => {
    const result = runGit('/work/project', ['worktree', 'add', '--detach', '/work/checkout', 'ref']);
    await vi.advanceTimersByTimeAsync(90_000);
    child.stdout.write('Checkout ready');
    child.emit('close', 0);
    expect(await result).toEqual(Buffer.from('Checkout ready'));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
