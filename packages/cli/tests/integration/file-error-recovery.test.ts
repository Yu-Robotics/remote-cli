import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'os';
import path from 'path';
import { MessageHandler } from '../../src/client/MessageHandler';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { ThreadExecutorPool } from '../../src/thread/ThreadExecutorPool';
import { ThreadManager } from '../../src/thread/ThreadManager';

describe('same-thread chat after file and directory errors', () => {
  const fileId = 'a'.repeat(64);
  const bytes = Buffer.from('synthetic attachment');
  const owner = 'fixture-owner';
  const plain = 'Continue the conversation';
  const send = vi.fn();
  const execute = vi.fn(async (_prompt: string) => ({ success: true, output: 'Reply' }));
  let home: string;
  let cwd: string;
  let threadId: string;
  let manager: ThreadManager;
  let handler: MessageHandler;
  let server: Server;
  let origin: string;

  async function openFixture() {
    send.mockClear();
    execute.mockClear();
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'file-recovery-')));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    cwd = path.join(home, 'project');
    await fs.mkdir(cwd);
    manager = await ThreadManager.initialize(home);
    threadId = manager.getDefaultThread().id;
    await manager.updateThread(threadId, { workingDirectory: cwd, delegation: false });
    server = createServer((_request, response) => response.end(bytes));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    startHandler();
  }

  function startHandler() {
    const guard = new DirectoryGuard([cwd]);
    const pool = new ThreadExecutorPool(manager, guard, { type: 'claude-persistent' },
      (_guard, _config, directory) => ({
        execute, getCurrentWorkingDirectory: () => directory ?? cwd, destroy: async () => {},
        setWorkingDirectory: async () => {}, resetContext: () => {}, abort: async () => true,
      }));
    const config = { getConfigDir: () => home, get: (key: string) => key === 'serverUrl' ? origin : undefined };
    handler = new MessageHandler({ send, isConnected: () => true, trackTask: vi.fn() } as any,
      pool, manager, guard, config as any);
  }

  async function restart() {
    await handler.destroy();
    manager = await ThreadManager.initialize(home);
    startHandler();
    await handler.handleMessage({ type: 'binding_confirm', data: { success: true, capabilities: { fileTransferV1: true } } } as any);
  }

  async function closeFixture() {
    try {
      await handler?.destroy();
    } finally {
      if (server?.listening) await new Promise<void>((resolve, reject) =>
        server.close(error => error ? reject(error) : resolve()));
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await fs.rm(home, { recursive: true, force: true });
    }
  }

  async function command(messageId: string, content: string, fileIds?: string[]) {
    await handler.handleMessage({ type: 'command', messageId, openId: owner, threadId,
      content, fileIds, timestamp: Date.now() });
    const replies = send.mock.calls.map(([frame]) => frame)
      .filter(frame => frame.type === 'response' && frame.messageId === messageId);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ threadId, openId: owner });
    return replies[0];
  }

  async function ordinaryChat() {
    expect(await command('ordinary', plain)).toMatchObject({ success: true, cwd });
    expect(execute).toHaveBeenLastCalledWith(plain, expect.anything());
  }

  async function receiveFile(id = fileId, thread = threadId) {
    await handler.handleMessage({ type: 'binding_confirm', data: { success: true, capabilities: { fileTransferV1: true } } } as any);
    await handler.handleMessage({ type: 'file_pending', fileId: id, threadId: thread, openId: owner,
      name: 'sample.bin', sourceMessageId: 'upload' } as any);
    const admitted = send.mock.calls.map(([frame]) => frame).find(frame => frame.status === 'admitted' && frame.fileId === id);
    expect(admitted).toMatchObject({ type: 'file_status', fileId: id, threadId: thread, destination: expect.any(String) });
    await handler.handleMessage({ type: 'file_available', fileId: id, destination: admitted.destination,
      token: 'b'.repeat(64), size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
      downloadPath: '/api/files/' + id, expiresAt: Date.now() + 60_000 } as any);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'file_status', fileId: id, status: 'unsupported', detail: expect.stringContaining('No built-in parser'),
    })), { timeout: 5000 });
    expect(execute).not.toHaveBeenCalled();
    const namespace = createHash('sha256').update(origin).digest('hex');
    const original = path.join(home, 'attachments', namespace, id, 'original.bin');
    expect(await fs.readFile(original)).toEqual(bytes);
    return original;
  }

  describe('file references and directory selection', () => {
    beforeEach(openFixture);
    afterEach(closeFixture);

    it.each(['outside', 'missing', 'regular-file'] as const)('keeps the current conversation after /cd to %s', async kind => {
      const target = kind === 'outside' ? home : path.join(cwd, kind);
      if (kind === 'regular-file') await fs.writeFile(target, bytes);
      const expected = { outside: 'is not allowed', missing: 'Directory does not exist', 'regular-file': 'Not a directory' };
      expect(await command('invalid-directory', '/cd ' + target)).toMatchObject({
        success: false, error: expect.stringContaining(expected[kind]), cwd,
      });
      expect(manager.getThread(threadId)?.workingDirectory).toBe(cwd);
      expect(execute).not.toHaveBeenCalled();
      await ordinaryChat();
    });

    it('retains an unsupported original for its instruction and omits it from the next chat', async () => {
      const original = await receiveFile();
      expect(await command('read', 'Inspect the original', [fileId])).toMatchObject({ success: true });
      const prompt = execute.mock.calls[0][0];
      expect(prompt).toContain(JSON.stringify(original));
      expect(prompt).toContain('"status":"unsupported"');
      expect(prompt).not.toContain('"extractedText"');
      await ordinaryChat();
    });

    it('rejects an expired reference and executes the next ordinary chat', async () => {
      await receiveFile();
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 86400_000);
      expect(await command('expired', 'Read the file', [fileId])).toMatchObject({
        success: false, error: 'Attachment expired. Please upload it again.',
      });
      expect(execute).not.toHaveBeenCalled();
      await ordinaryChat();
    });
  });

  describe('attachment recovery', () => {
    beforeEach(openFixture);
    afterEach(closeFixture);

    it.each([false, true])('reports a missing original once and keeps ordinary chat usable (restart=%s)', async reload => {
      await fs.unlink(await receiveFile());
      const rejected = await command('missing-original', 'Read the file', [fileId]);
      expect(rejected).toMatchObject({ success: false, error: expect.stringMatching(/upload.*again/i), cwd });
      expect(rejected.error).not.toContain(home);
      expect(execute).not.toHaveBeenCalled();
      if (reload) await restart();
      await ordinaryChat();
      const explicit = await command('retry-file', 'Inspect it again', [fileId]);
      expect(explicit).toMatchObject({ success: false, error: rejected.error });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(await command('cleanup', '/files clear')).toMatchObject({ success: true });
    });

    it('keeps chat usable when the missing-original report cannot be saved', async () => {
      const original = await receiveFile();
      const manifest = path.join(path.dirname(original), 'metadata.json');
      await fs.unlink(original);
      const rename = fs.rename.bind(fs);
      const fault = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (to === manifest) throw Object.assign(new Error('Access denied: ' + manifest), { code: 'EACCES' });
        return rename(from, to);
      });
      const result = await command('missing', 'Read the original', [fileId]);
      expect(result).toMatchObject({ success: false, error: expect.stringMatching(/upload.*again/i) });
      expect(result.error).not.toContain(home);
      await ordinaryChat();
      await restart();
      expect(fault).toHaveBeenCalledWith(expect.anything(), manifest);
      fault.mockRestore();
      expect(await command('after-restart', plain)).toMatchObject({ success: false, error: result.error });
      expect(await command('continue', plain)).toMatchObject({ success: true, cwd });
    });

    it('reports committed deletion and retries only the expired attachments after restart', async () => {
      const target = await manager.createThread('retire', cwd, 'claude-persistent');
      const locked = await receiveFile(fileId, target.id);
      const removable = await receiveFile('c'.repeat(64), target.id);
      const unverified = await receiveFile('e'.repeat(64), target.id);
      const retained = await receiveFile('d'.repeat(64));
      const remove = fs.rm.bind(fs);
      const fault = vi.spyOn(fs, 'rm').mockImplementation(async (file, options) => {
        if (file === path.dirname(locked)) throw Object.assign(new Error('Access denied: ' + locked), { code: 'EACCES' });
        if (file === path.dirname(unverified)) {
          await fs.unlink(path.join(file, 'metadata.json'));
          throw Object.assign(new Error('Partial directory removal'), { code: 'EBUSY' });
        }
        return remove(file, options);
      });
      const result = await command('delete', '/thread delete retire');
      expect(result).toMatchObject({ success: true, output: expect.stringMatching(/Thread "retire" deleted.*attachment cleanup is incomplete/s) });
      expect(result.output).not.toContain(home);
      expect(send.mock.calls.map(([frame]) => frame).filter(frame =>
        frame.fileId === fileId && frame.detail?.includes('Local attachment removed'))).toEqual([]);
      expect(manager.getThread(target.id)).toBeUndefined();
      expect(await fs.readFile(locked)).toEqual(bytes);
      await expect(fs.stat(removable)).rejects.toMatchObject({ code: 'ENOENT' });
      await restart();
      expect(await command('use-retained', 'Read the retained attachment')).toMatchObject({ success: true });
      expect(execute.mock.lastCall?.[0]).toContain(JSON.stringify(retained));
      await ordinaryChat();
      fault.mockRestore();
      await restart();
      await expect(fs.stat(path.dirname(locked))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fs.readFile(retained)).toEqual(bytes);
      expect(await fs.readFile(unverified)).toEqual(bytes);
    });
  });
});
