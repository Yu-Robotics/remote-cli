import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { FileInbox, FileContext } from '../src/files/FileInbox';
import { atomicJson } from '../src/files/FileIO';

describe('file inbox lifecycle and references', () => {
  let root: string; let inbox: FileInbox; let thread: FileContext | undefined; let send: ReturnType<typeof vi.fn>;
  const id = 'a'.repeat(64);
  const message = { fileId: id, name: 'report.txt', openId: 'owner', sourceMessageId: 'source' };
  function createInbox() {
    return new FileInbox(path.join(root, 'files'), 'https://router.test', { thread: () => thread, send,
      extract: async () => ({ status: 'unsupported', detail: 'No parser' }) });
  }
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'file-inbox-')));
    thread = { id: 'thread', workingDirectory: path.join(root, 'project'), delegationWorkspaceGeneration: 0 }; send = vi.fn();
    inbox = createInbox();
  });
  afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await inbox.destroy(); await fs.rm(root, { recursive: true, force: true }); });
  async function recreate() {
    await inbox.destroy(); inbox = createInbox(); await inbox.initialize();
  }
  async function saved() {
    await inbox.accept(message);
    const p = (inbox as any).entries.get(id);
    clearTimeout(p.timer);
    Object.assign(p.entry, { state: 'saved', size: 4, sha256: 'b'.repeat(64), detail: 'Original saved.' });
    await fs.writeFile(path.join(root, 'files', id, 'original.txt'), 'data');
    await (inbox as any).persist(p); p.finish(); return p;
  }
  it('does not start a task for file-only messages, sanitizes names and re-acknowledges duplicates', async () => {
    await inbox.accept({ ...message, name: '../AGENTS.md\u0000' });
    expect(send.mock.calls[0][0]).toMatchObject({ status: 'admitted', threadId: 'thread' });
    await inbox.accept({ ...message, openId: 'stranger' }); expect(send).toHaveBeenCalledTimes(1);
    await inbox.accept(message); expect(send).toHaveBeenCalledTimes(2);
    expect((await fs.readdir(path.join(root, 'files', id)))).toEqual(['metadata.json']);
    expect((await inbox.list('thread', 'owner'))).toContain('../AGENTS.md');
  });
  it('rejects stale-generation duplicates and missing threads without silently retargeting', async () => {
    await inbox.accept(message); thread!.delegationWorkspaceGeneration = 1;
    await inbox.accept(message); expect(send.mock.calls.at(-1)![0]).toMatchObject({ status: 'failed' });
    thread = undefined; await inbox.accept({ ...message, fileId: 'c'.repeat(64) });
    expect(send.mock.calls.at(-1)![0].detail).toContain('Thread not found');
  });
  it('pins references across queue ID changes and restores them on cancellation', async () => {
    await saved(); inbox.claim('queued', 'thread', 'owner'); inbox.moveClaim('queued', 'running');
    expect(await inbox.list('thread', 'owner', true)).toContain('(in use)');
    expect(await inbox.prepare('running')).toContain('original.txt');
    inbox.release('running'); inbox.claim('next', 'thread', 'owner'); expect(inbox.hasClaim('next')).toBe(true);
    inbox.release('next', false); inbox.claim('after', 'thread', 'owner'); expect(inbox.hasClaim('after')).toBe(false);
    await inbox.list('thread', 'owner', true); await expect(fs.stat(path.join(root, 'files', id))).rejects.toThrow();
  });
  it('does not resurrect files while an asynchronous release write races cleanup', async () => {
    await saved(); inbox.claim('task', 'thread', 'owner'); inbox.release('task');
    await inbox.list('thread', 'owner', true); await inbox.destroy();
    await expect(fs.stat(path.join(root, 'files', id))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('does not cancel a completed saved file when aborting a later task', async () => {
    await saved(); inbox.cancelThread('thread');
    expect(await inbox.list('thread', 'owner')).toContain('saved');
  });
  it('rejects changed files and wrong owner, thread or explicit IDs', async () => {
    await saved();
    expect(() => inbox.claim('other', 'thread', 'stranger', [id])).toThrow('unavailable');
    expect(() => inbox.claim('other', 'elsewhere', 'owner', [id])).toThrow('unavailable');
    expect(() => inbox.claim('bad', 'thread', 'owner', ['../bad'])).toThrow('Invalid');
    inbox.claim('task', 'thread', 'owner');
    await fs.writeFile(path.join(root, 'files', id, 'original.txt'), 'changed size');
    await expect(inbox.prepare('task')).rejects.toThrow('changed');
  });
  it('keeps failure visible to the next instruction and clears owned data on thread deletion', async () => {
    await inbox.accept(message); await inbox.failed(id, 'download failed');
    inbox.claim('task', 'thread', 'owner'); await expect(inbox.prepare('task')).rejects.toThrow('download failed');
    await inbox.deleteThread('thread'); await expect(fs.stat(path.join(root, 'files', id))).rejects.toThrow();
  });
  it.each([false, true])('reports an oversized attachment once implicitly across restart (initial reload=%s)', async reload => {
    await inbox.accept(message); await inbox.failed(id, 'File exceeds the 20 MiB limit.');
    if (reload) await recreate();
    inbox.claim('first', 'thread', 'owner');
    expect(inbox.hasClaim('first')).toBe(true);
    await expect(inbox.prepare('first')).rejects.toThrow('File exceeds the 20 MiB limit.');
    inbox.release('first');
    inbox.claim('plain', 'thread', 'owner');
    expect(inbox.hasClaim('plain')).toBe(false); expect(await inbox.prepare('plain')).toBe('');
    await recreate();
    inbox.claim('after-restart', 'thread', 'owner');
    expect(inbox.hasClaim('after-restart')).toBe(false);
    expect(await inbox.list('thread', 'owner')).toContain('failed');
    inbox.claim('explicit', 'thread', 'owner', [id]);
    await expect(inbox.prepare('explicit')).rejects.toThrow('File exceeds the 20 MiB limit.');
    inbox.release('explicit');
    inbox.claim('after-explicit', 'thread', 'owner'); expect(inbox.hasClaim('after-explicit')).toBe(false);
    expect(() => inbox.claim('wrong-owner', 'thread', 'stranger', [id])).toThrow('unavailable');
    expect(() => inbox.claim('wrong-thread', 'elsewhere', 'owner', [id])).toThrow('unavailable');
    thread!.delegationWorkspaceGeneration = 1;
    expect(() => inbox.claim('wrong-generation', 'thread', 'owner', [id])).toThrow('earlier');
  });
  it('does not confuse a persisted claim reservation with a reported failure after restart', async () => {
    await inbox.accept(message); inbox.claim('queued', 'thread', 'owner');
    await inbox.failed(id, 'Reserved transfer failed.');
    const metadata = JSON.parse(await fs.readFile(path.join(root, 'files', id, 'metadata.json'), 'utf8'));
    expect(metadata.consumed).toBe(true);
    await recreate();
    inbox.claim('first-after-restart', 'thread', 'owner');
    await expect(inbox.prepare('first-after-restart')).rejects.toThrow('Reserved transfer failed.');
    inbox.release('first-after-restart');
    await recreate();
    inbox.claim('plain', 'thread', 'owner'); expect(inbox.hasClaim('plain')).toBe(false);
  });
  it('reports a reserved transfer interrupted by restart before allowing plain messages through', async () => {
    await inbox.accept(message); inbox.claim('interrupted', 'thread', 'owner');
    await recreate(); inbox.claim('retry', 'thread', 'owner');
    await expect(inbox.prepare('retry')).rejects.toThrow('disconnected'); inbox.release('retry');
    await recreate(); inbox.claim('plain', 'thread', 'owner'); expect(inbox.hasClaim('plain')).toBe(false);
  });
  it('reserves an unsurfaced failure for the first queued instruction across queue ID changes', async () => {
    await inbox.accept(message); await inbox.failed(id, 'Queued transfer failed.');
    inbox.claim('queued', 'thread', 'owner'); inbox.claim('later', 'thread', 'owner');
    expect(inbox.hasClaim('queued')).toBe(true); expect(inbox.hasClaim('later')).toBe(false);
    inbox.moveClaim('queued', 'running');
    await expect(inbox.prepare('running')).rejects.toThrow('Queued transfer failed.'); inbox.release('running');
    await recreate(); inbox.claim('plain', 'thread', 'owner'); expect(inbox.hasClaim('plain')).toBe(false);
  });
  it.each([false, true])('restores an unsurfaced failure when cancelling a queued claim (failed before release=%s)', async failFirst => {
    await inbox.accept(message); inbox.claim('queued', 'thread', 'owner');
    if (failFirst) await inbox.failed(id, 'Queued transfer failed.');
    inbox.release('queued');
    if (!failFirst) await inbox.failed(id, 'Queued transfer failed.');
    inbox.claim('retry', 'thread', 'owner');
    await expect(inbox.prepare('retry')).rejects.toThrow('Queued transfer failed.');
    inbox.release('retry');
    await recreate(); inbox.claim('plain', 'thread', 'owner'); expect(inbox.hasClaim('plain')).toBe(false);
  });
  it('restores usable files and later unsurfaced failures after partial multi-file preparation', async () => {
    await saved();
    const failedIds = ['c'.repeat(64), 'd'.repeat(64)];
    for (const fileId of failedIds) {
      await inbox.accept({ ...message, fileId }); await inbox.failed(fileId, `Rejected ${fileId[0]}.`);
    }
    inbox.claim('first', 'thread', 'owner');
    await expect(inbox.prepare('first')).rejects.toThrow('Rejected c.'); inbox.release('first');
    inbox.claim('second', 'thread', 'owner');
    await expect(inbox.prepare('second')).rejects.toThrow('Rejected d.'); inbox.release('second');
    await recreate();
    inbox.claim('usable', 'thread', 'owner');
    const content = await inbox.prepare('usable');
    expect(content).toContain(id); for (const fileId of failedIds) expect(content).not.toContain(fileId);
    inbox.release('usable', false);
    await recreate(); inbox.claim('plain', 'thread', 'owner'); expect(inbox.hasClaim('plain')).toBe(false);
  });
  it('keeps a later failure pending when an earlier saved file cannot be prepared', async () => {
    await saved(); const failedId = 'c'.repeat(64);
    await inbox.accept({ ...message, fileId: failedId }); await inbox.failed(failedId, 'Later attachment failed.');
    const original = path.join(root, 'files', id, 'original.txt');
    await fs.writeFile(original, 'changed');
    inbox.claim('first', 'thread', 'owner');
    await expect(inbox.prepare('first')).rejects.toThrow('changed'); inbox.release('first');
    await fs.writeFile(original, 'data');
    inbox.claim('retry', 'thread', 'owner');
    await expect(inbox.prepare('retry')).rejects.toThrow('Later attachment failed.'); inbox.release('retry');
    inbox.claim('usable', 'thread', 'owner'); expect(await inbox.prepare('usable')).toContain(id);
  });
  it('does not acknowledge a failure from a released preparation waiting for transfer', async () => {
    await inbox.accept(message); inbox.claim('cancelled', 'thread', 'owner');
    const rejected = expect(inbox.prepare('cancelled')).rejects.toThrow('Attachment task cancelled.');
    inbox.release('cancelled'); await inbox.failed(id, 'Transfer failed after release.'); await rejected;
    await recreate(); inbox.claim('retry', 'thread', 'owner');
    await expect(inbox.prepare('retry')).rejects.toThrow('Transfer failed after release.');
    inbox.release('retry'); inbox.claim('plain', 'thread', 'owner'); expect(inbox.hasClaim('plain')).toBe(false);
  });
  it('does not acknowledge a failure when release races its metadata write', async () => {
    await inbox.accept(message); await inbox.failed(id, 'Transfer failed.'); inbox.claim('cancelled', 'thread', 'owner');
    const rename = fs.rename.bind(fs);
    let finish!: () => void; let entered!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    const writing = new Promise<void>(resolve => { entered = resolve; });
    const spy = vi.spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => {
      entered(); await held; return rename(from, to);
    });
    const rejected = expect(inbox.prepare('cancelled')).rejects.toThrow('Attachment task cancelled.');
    try { await writing; inbox.release('cancelled'); } finally { finish(); }
    await rejected; spy.mockRestore();
    await recreate(); inbox.claim('retry', 'thread', 'owner');
    await expect(inbox.prepare('retry')).rejects.toThrow('Transfer failed.'); inbox.release('retry');
    await recreate(); inbox.claim('plain', 'thread', 'owner'); expect(inbox.hasClaim('plain')).toBe(false);
  });
  it('preserves another explicit reporter when a cancelled acknowledgement rolls back', async () => {
    await inbox.accept(message); await inbox.failed(id, 'Transfer failed.'); inbox.claim('cancelled', 'thread', 'owner');
    const rename = fs.rename.bind(fs);
    let finish!: () => void; let entered!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    const writing = new Promise<void>(resolve => { entered = resolve; });
    const spy = vi.spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => {
      entered(); await held; return rename(from, to);
    });
    const cancelled = expect(inbox.prepare('cancelled')).rejects.toThrow('Attachment task cancelled.');
    await writing;
    inbox.claim('explicit', 'thread', 'owner', [id]);
    const reported = expect(inbox.prepare('explicit')).rejects.toThrow('Transfer failed.');
    try { inbox.release('cancelled'); } finally { finish(); }
    await Promise.all([cancelled, reported]); spy.mockRestore(); inbox.release('explicit');
    await recreate(); inbox.claim('plain', 'thread', 'owner'); expect(inbox.hasClaim('plain')).toBe(false);
  });
  it('filters old directories and newly arrived files from implicit claims', async () => {
    const before = inbox.mark(); await saved(); inbox.claim('before', 'thread', 'owner', undefined, before);
    expect(inbox.hasClaim('before')).toBe(false); thread!.workingDirectory = path.join(root, 'different');
    inbox.claim('newcwd', 'thread', 'owner'); expect(inbox.hasClaim('newcwd')).toBe(false);
    expect(() => inbox.claim('explicit', 'thread', 'owner', [id])).toThrow('earlier');
  });
  it('expires terminal records but preserves pinned files until released', async () => {
    const p = await saved(); inbox.claim('task', 'thread', 'owner'); p.entry.expiresAt = Date.now() - 1;
    expect(await inbox.list('thread', 'owner')).toContain('(in use)');
    await expect(inbox.prepare('task')).rejects.toThrow('expired');
    inbox.release('task'); expect(await inbox.list('thread', 'owner')).toContain('No attachments');
  });
  it('restores interrupted parsing honestly and never trusts symlinked or oversized manifests', async () => {
    const p = await saved(); p.entry.state = 'parsing'; await (inbox as any).persist(p); await inbox.destroy();
    const manifest = path.join(root, 'files', id, 'metadata.json');
    inbox = new FileInbox(path.join(root, 'files'), 'https://router.test', { thread: () => thread, send, extract: vi.fn() });
    await inbox.initialize(); inbox.claim('task', 'thread', 'owner'); expect(await inbox.prepare('task')).toContain('interrupted by restart');
    await inbox.destroy();
    await fs.rename(manifest, path.join(root, 'external.json')); await fs.symlink(path.join(root, 'external.json'), manifest, 'file');
    inbox = new FileInbox(path.join(root, 'files'), 'https://router.test', { thread: () => thread, send, extract: vi.fn() });
    expect(await inbox.list('thread', 'owner')).toContain('No attachments');
  });
  it('fails invalid offers, ignores unknown destinations and bounds retention configuration', async () => {
    await inbox.accept(message); const destination = send.mock.calls[0][0].destination;
    inbox.available({ fileId: id, destination: 'other' }); expect(send).toHaveBeenCalledTimes(1);
    inbox.available({ fileId: id, destination, size: 21 * 1024 * 1024 });
    await vi.waitFor(() => expect(send.mock.calls.at(-1)![0].status).toBe('failed'));
    expect(() => new FileInbox(root, 'https://router.test', {} as any, 0)).toThrow('retentionDays');
    expect(() => new FileInbox(root, 'https://router.test', {} as any, 31)).toThrow('retentionDays');
  });
  it('marks pending transfers failed on disconnect and has bounded pending wait', async () => {
    await inbox.accept(message); inbox.claim('task', 'thread', 'owner'); inbox.disconnect();
    await expect(inbox.prepare('task')).rejects.toThrow('disconnected');
    await inbox.accept({ ...message, fileId: 'c'.repeat(64) });
    vi.useFakeTimers();
    const pending = (inbox as any).entries.get('c'.repeat(64));
    pending.timer._onTimeout();
    expect(pending.entry.state).toBe('failed');
  });
});
