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
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'file-inbox-')));
    thread = { id: 'thread', workingDirectory: path.join(root, 'project'), delegationWorkspaceGeneration: 0 }; send = vi.fn();
    inbox = new FileInbox(path.join(root, 'files'), 'https://router.test', { thread: () => thread, send,
      extract: async () => ({ status: 'unsupported', detail: 'No parser' }) });
  });
  afterEach(async () => { vi.useRealTimers(); await inbox.destroy(); await fs.rm(root, { recursive: true, force: true }); });
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
  it('filters old directories and newly arrived files from implicit claims', async () => {
    const before = inbox.mark(); await saved(); inbox.claim('before', 'thread', 'owner', undefined, before);
    expect(inbox.hasClaim('before')).toBe(false); thread!.workingDirectory = '/different';
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
    await fs.rename(manifest, path.join(root, 'external.json')); await fs.symlink(path.join(root, 'external.json'), manifest);
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
