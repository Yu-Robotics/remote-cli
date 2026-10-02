// Run the shared real-HTTP workflow under Router coverage as well as CLI coverage.
import '../../cli/tests/integration/file-transfer.test';
import { describe, beforeEach, afterEach, it, expect, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { Readable, PassThrough } from 'stream';
import { randomUUID } from 'crypto';
import { FileTransfers } from '../src/files/FileTransfers';

describe('Router transfer deadlines and quotas', () => {
  let root: string; let router: FileTransfers; let notices: any[]; let messages: any[];
  let session: any; let download: ReturnType<typeof vi.fn>; let sequence: number;
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'router-transfer-')));
    notices = []; messages = []; sequence = 0; session = { id: 'session', openId: 'owner' };
    download = vi.fn(async () => Readable.from([Buffer.from('data')]));
    router = new FileTransfers(root, 'http://127.0.0.1', undefined, {
      session: () => session, owns: async () => true, download,
      send: async (device, message: any) => {
        messages.push(message);
        if (message.type === 'file_pending') await router.handleStatus(device, { fileId: message.fileId, status: 'admitted', threadId: 'thread', destination: randomUUID() });
        return true;
      },
      notify: async record => { notices.push(record); return `card-${record.id}`; },
    });
  });
  afterEach(async () => { vi.useRealTimers(); await router.destroy(); await fs.rm(root, { recursive: true, force: true }); });
  const upload = () => router.receive({ openId: 'owner', deviceId: 'device', messageId: `message_${++sequence}`, fileKey: 'key', name: 'file.txt' });
  async function offer() { await upload(); await vi.waitFor(() => expect(messages.some(m => m.type === 'file_available')).toBe(true)); return messages.find(m => m.type === 'file_available'); }
  it('holds the per-device slot until a verified saved acknowledgement, not just HTTP offer', async () => {
    const first = await offer(); await upload(); expect(download).toHaveBeenCalledTimes(1);
    await router.handleStatus('device', { ...first, status: 'saved', sha256: 'bad' }); expect(download).toHaveBeenCalledTimes(1);
    await router.handleStatus('device', { ...first, status: 'saved' });
    await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(2));
  });
  it('limits six devices to four active streams and releases a slot after cancellation', async () => {
    download.mockImplementation(async () => new PassThrough());
    for (let index = 0; index < 6; index++) await router.receive({ openId: 'owner', deviceId: `device-${index}`, messageId: `message_${index}`, fileKey: 'key', name: 'data.txt' });
    await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(4));
    expect((router as any).active).toBe(4);
    const file = [...(router as any).files.values()].find((file: any) => file.record.deviceId === 'device-0') as any;
    await router.handleStatus('device-0', { fileId: file.record.id, destination: file.record.destination, status: 'failed', detail: 'Cancelled' });
    await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(5));
    expect((router as any).active).toBe(4);
  });
  it('retries transient Feishu resets but never retries permanent permission or size failures', async () => {
    download.mockRejectedValueOnce(Object.assign(new Error('upstream reset'), { code: 'ECONNRESET' }));
    const first = await offer(); expect(download).toHaveBeenCalledTimes(2);
    await router.handleStatus('device', { ...first, status: 'saved' });
    download.mockRejectedValueOnce(new Error('permission denied'));
    await upload(); await vi.waitFor(() => expect(notices.some(n => n.state === 'failed')).toBe(true));
    expect(download).toHaveBeenCalledTimes(3);
  });
  it('ignores wrong-device/destination status and cannot regress a terminal parser result', async () => {
    const first = await offer();
    await router.handleStatus('stranger', { ...first, status: 'failed' });
    await router.handleStatus('device', { ...first, destination: 'wrong', status: 'failed' });
    expect((router as any).files.get(first.fileId).record.state).toBe('transferring');
    await router.handleStatus('device', { ...first, status: 'parsed', detail: 'parsed' });
    await router.handleStatus('device', { ...first, status: 'saved' });
    expect((router as any).files.get(first.fileId).record.state).toBe('parsed');
    expect(router.resolve('owner', 'message_1')).toMatchObject({ threadId: 'thread', deviceId: 'device' });
    expect(router.resolve('stranger', 'message_1')).toBeUndefined();
  });
  it('stops promptly before response headers when upstream ignores cancellation', async () => {
    download.mockReturnValue(new Promise(() => {})); await upload();
    await vi.waitFor(() => expect(download).toHaveBeenCalled());
    await router.destroy(); expect((router as any).active).toBe(0);
    await expect(upload()).rejects.toThrow('stopped');
  });
  it('enforces admission and total deadlines and expires failed records early', async () => {
    const first = await offer();
    const file = (router as any).files.get(first.fileId);
    file.offers = 3; file.timer._onTimeout();
    await vi.waitFor(() => expect(file.record.state).toBe('failed'));
    expect(file.record.expiresAt).toBeLessThan(Date.now() + 16 * 60_000);
    file.record.expiresAt = Date.now() - 1; await (router as any).cleanup();
    expect((router as any).files.has(first.fileId)).toBe(false);
  });
  it('has explicit Router quota feedback and rejects insecure configuration', async () => {
    await offer();
    for (let i = 0; i < 19; i++) await upload();
    await expect(upload()).rejects.toThrow('quota');
    expect(() => new FileTransfers(root, 'http://public.test', undefined, {} as any)).toThrow('HTTPS');
    expect(() => new FileTransfers(root, 'https://user:password@public.test', undefined, {} as any)).toThrow('HTTPS');
    expect(() => new FileTransfers(root, 'https://public.test', 21 * 1024 * 1024, {} as any)).toThrow('20 MiB');
  });
  it('restores completed routing metadata but never replays interrupted downloads', async () => {
    const first = await offer(); await router.destroy();
    router = new FileTransfers(root, 'http://127.0.0.1', undefined, { session: () => session, owns: async () => true, send: vi.fn(), download, notify: async () => undefined });
    await router.initialize();
    expect((router as any).files.get(first.fileId).record.state).toBe('failed');
    expect(download).toHaveBeenCalledTimes(1);
  });
});
