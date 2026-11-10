import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'path';
import os from 'os';
import { PendingOutputFiles } from '../../src/output/PendingOutputFiles';
import { OutputLinks } from '../../src/output/OutputLinks';
import { OutputFiles } from '../../src/output/OutputFiles';
import { OUTPUT_LIMITS } from '../../src/output/Protocol';

const context = () => ({ messageId: 'original', threadId: 'thread', taskId: 'original', generation: 3,
  owner: 'owner', cwd: path.join(os.tmpdir(), 'synthetic-workspace'), source: 'workspace' as const });
const links = (file = 'output/report.csv') => { const value = new OutputLinks(); value.append(`[Report](<${file}> "attachment")`); return value; };
const request = () => ({ messageId: 'original', threadId: 'thread', generation: 3, openId: 'owner' });
afterEach(() => vi.restoreAllMocks());

describe('pending output intent metadata', () => {
  it('does not touch snapshots before approval and prepares exact original paths only after connected capability', async () => {
    const pending = new PendingOutputFiles(), snapshot = vi.fn(async () => ({}));
    const snapshots = { snapshot, references: () => [] } as any;
    const files = new OutputFiles(snapshots, 'https://router.example.com', vi.fn());
    try {
      pending.remember(links(), context(), () => true);
      expect(snapshot).not.toHaveBeenCalled();
      expect(await pending.prepare(request(), files)).toBe(false);
      expect(snapshot).not.toHaveBeenCalled();
      files.connect();
      expect(await pending.prepare(request(), files)).toBe(true);
      expect(snapshot).toHaveBeenCalledOnce();
      expect(snapshot).toHaveBeenCalledWith('output/report.csv', expect.objectContaining({ ...context(), expiresAt: expect.any(Number), current: expect.any(Function) }));
      expect(await pending.prepare(request(), files)).toBe(false);
    } finally { files.disable(); }
  });
  it.each(['owner', 'thread', 'generation', 'message', 'stale', 'expired', 'disconnected', 'disabled', 'restart'])('never prepares %s intent', async mode => {
    const pending = new PendingOutputFiles(), capturePaths = vi.fn(); let current = true;
    const files = { canPrepare: () => !['disconnected', 'disabled'].includes(mode), capturePaths } as any;
    pending.remember(links(), context(), () => current);
    const input = request();
    if (mode === 'owner') input.openId = 'other';
    if (mode === 'thread') input.threadId = 'other';
    if (mode === 'generation') input.generation++;
    if (mode === 'message') input.messageId = 'other';
    if (mode === 'stale') current = false;
    if (mode === 'expired') vi.spyOn(Date, 'now').mockReturnValue(Date.now() + OUTPUT_LIMITS.ttl);
    expect(await (mode === 'restart' ? new PendingOutputFiles() : pending).prepare(input, files)).toBe(false);
    expect(capturePaths).not.toHaveBeenCalled();
  });
  it('does not let a disconnected preparation resume reads under a replacement connection', async () => {
    const pending = new PendingOutputFiles(); let allowed: (() => boolean) | undefined;
    const snapshots = { references: () => [], snapshot: vi.fn(async (_path, context) => { allowed = context.current; }) } as any;
    const files = new OutputFiles(snapshots, 'https://router.example.com', vi.fn());
    try {
      files.connect(); pending.remember(links(), context(), () => true); await pending.prepare(request(), files);
      expect(allowed!()).toBe(true); files.disconnect(); files.connect(); expect(allowed!()).toBe(false);
    } finally { files.disable(); }
  });
  it('coalesces preparation, copies exports and fixes expiry at intent time', async () => {
    const pending = new PendingOutputFiles(), ctx = { ...context(), exports: [{ file: 'exact', path: 'report.csv', sha256: 'a'.repeat(64), bytes: 5, taskId: 'worker' }] };
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now);
    pending.remember(links(), ctx, () => true); ctx.exports[0].file = 'changed';
    let release!: () => void;
    const capturePaths = vi.fn(async (_paths, captured) => {
      expect(captured.exports[0].file).toBe('exact'); expect(captured.expiresAt).toBe(now + OUTPUT_LIMITS.ttl);
      await new Promise<void>(resolve => { release = resolve; }); return { unavailable: 0 };
    });
    const files = { canPrepare: () => true, preparationLease: () => () => true, capturePaths } as any;
    const first = pending.prepare(request(), files);
    expect(await pending.prepare(request(), files)).toBe(false); release(); expect(await first).toBe(true);
    expect(capturePaths).toHaveBeenCalledOnce();
  });
  it('invalidates consumed work when a new command starts or the handler stops', async () => {
    for (const clear of [false, true]) {
      const pending = new PendingOutputFiles(); let captured: any;
      pending.remember(links(), context(), () => true);
      const files = { canPrepare: () => true, preparationLease: () => () => true, capturePaths: vi.fn(async (_p, c) => { captured = c; return { unavailable: 0 }; }) } as any;
      await pending.prepare(request(), files); expect(captured.current()).toBe(true);
      if (clear) pending.clear(); else pending.invalidateThread('thread');
      expect(captured.current()).toBe(false);
    }
  });
  it('merges native continuation selections without extending the original expiry or crossing context', async () => {
    const pending = new PendingOutputFiles(); const now = Date.now(); const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    pending.remember(links('first/report.csv'), context(), () => true);
    clock.mockReturnValue(now + 1000);
    pending.remember(links('second/report.csv'), context(), () => true);
    pending.remember(links('foreign/report.csv'), { ...context(), cwd: path.join(os.tmpdir(), 'other-workspace') }, () => true);
    const capturePaths = vi.fn(async (_paths, c) => { expect(c.expiresAt).toBe(now + OUTPUT_LIMITS.ttl); return { unavailable: 0 }; });
    await pending.prepare(request(), { canPrepare: () => true, preparationLease: () => () => true, capturePaths } as any);
    expect(capturePaths.mock.calls[0][0]).toEqual(['first/report.csv', 'second/report.csv']);
  });
  it('does not guess a basename, retry missing files, or retain unbounded metadata', async () => {
    const pending = new PendingOutputFiles();
    const capturePaths = vi.fn(async () => ({ unavailable: 1 })); const files = { canPrepare: () => true, preparationLease: () => () => true, capturePaths } as any;
    pending.remember(links('exact/missing.csv'), context(), () => true);
    expect(await pending.prepare(request(), files)).toBe(false); expect(await pending.prepare(request(), files)).toBe(false);
    expect(capturePaths.mock.calls[0][0]).toEqual(['exact/missing.csv']);
    for (let i = 0; i < 101; i++) pending.remember(links(), { ...context(), messageId: `message-${i}`, threadId: `thread-${i}` }, () => true);
    expect((pending as any).intents.size).toBe(100);
  });
});
