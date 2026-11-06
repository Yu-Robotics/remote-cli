import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import http from 'http';
import { createHash } from 'crypto';
import { OutputSnapshots, type SnapshotContext } from '../../src/output/OutputSnapshots';
import { OutputFiles } from '../../src/output/OutputFiles';
import { OutputLinks } from '../../src/output/OutputLinks';
import { OUTPUT_LIMITS } from '../../src/output/Protocol';
import * as durability from '../../src/output/Durable';

let root: string, parent: string, worker: string, store: OutputSnapshots, client: OutputFiles;
let frames: any[];
const owner = 'synthetic-owner';
const workerContext = (): SnapshotContext => ({ owner, cwd: worker, messageId: 'parent-command', threadId: 'thread',
  taskId: 'worker-task', generation: 2, source: 'worker' });
const parentContext = (): SnapshotContext => ({ ...workerContext(), cwd: parent, taskId: 'parent-command', source: 'workspace' });
const links = (filename: string) => { const value = new OutputLinks(); value.append(`[report](<${filename}>)`); return value; };
const filename = () => path.join(worker, 'report.txt');
const read = async (id: string) => {
  const parts: Buffer[] = [];
  await store.read(id, async bytes => { for await (const part of bytes) parts.push(part); });
  return Buffer.concat(parts).toString();
};
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'worker-output-visibility-')));
  parent = path.join(root, 'parent'); worker = path.join(root, 'worker');
  const home = path.join(root, 'home');
  await Promise.all([fs.mkdir(parent), fs.mkdir(worker), fs.mkdir(home)]);
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  await fs.writeFile(filename(), 'original worker bytes');
  store = new OutputSnapshots(path.join(root, 'snapshots'));
  frames = []; client = new OutputFiles(store, 'http://127.0.0.1:3000', value => frames.push(value));
  await client.initialize(); client.connect();
});
afterEach(async () => {
  vi.useRealTimers(); await client.destroy(); vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe('private worker capture and explicit publication', () => {
  it('keeps eligible, missing, denied and capped worker discoveries off the wire', async () => {
    const input = links(filename()); input.append(' [missing](missing.txt) [denied](.secret)');
    input.append(Array.from({ length: 20 }, (_, i) => ` [extra](${i}.txt)`).join(' '));
    expect(await client.capture(input, workerContext())).toMatchObject({ unavailable: 15, omitted: true });
    expect(store.references()).toEqual([]); expect(frames).toEqual([]);
    client.disconnect(); client.connect(); expect(frames).toEqual([]);
    client.disconnect();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try { client.connect(); await vi.advanceTimersByTimeAsync(45_000); expect(frames).toEqual([]); }
    finally { client.disconnect(); vi.useRealTimers(); }
    const records = (await fs.readdir(store.root)).filter(name => name.endsWith('.json'));
    expect(records).toHaveLength(1);
    const hidden = JSON.parse(await fs.readFile(path.join(store.root, records[0]), 'utf8'));
    expect(records[0]).toMatch(/\.worker\.json$/);
    // A legacy reader's exact filename patterns cannot discover or reclaim these bytes.
    expect((await fs.readdir(store.root)).filter(name => /^[a-f0-9]{64}\.(json|bin|tmp)$/.test(name))).toEqual([]);
    expect(hidden.publication.visible).toBe(false);
    expect(hidden.reference.discoveryIncomplete).toBeUndefined();
    await expect(read(hidden.reference.id)).rejects.toThrow('not published');
    client.connect();
    client.handle({ type: 'output_grant', id: hidden.reference.id, transferId: 'b'.repeat(64), token: 'c'.repeat(64), expiresAt: Date.now() + 1000 });
    expect((client as any).tasks.size).toBe(0); expect(frames).toEqual([]);
  });

  it('survives cleanup, fresh objects and repeated selection without exposing private origin metadata', async () => {
    const hidden = await store.snapshot(filename(), workerContext());
    await fs.rm(worker, { recursive: true });
    await client.destroy();
    store = new OutputSnapshots(path.join(root, 'snapshots'));
    client = new OutputFiles(store, 'http://127.0.0.1:3000', value => frames.push(value));
    await client.initialize(); client.connect(); expect(frames).toEqual([]);
    await client.capture(links(filename()), parentContext());
    expect(store.references()).toHaveLength(1);
    const selected = store.references()[0];
    expect(selected).toMatchObject({ id: hidden.id, sha256: hidden.sha256, size: hidden.size, expiresAt: hidden.expiresAt });
    expect(await read(selected.id)).toBe('original worker bytes');
    expect(JSON.stringify(frames)).not.toContain(worker); expect(JSON.stringify(frames)).not.toContain('publication');
    client.handle({ type: 'output_registered', id: selected.id });
    await client.capture(links(filename()), parentContext());
    expect(frames.filter(frame => frame.type === 'output_offer')).toHaveLength(1);
    client.disconnect(); client.connect();
    expect(frames.filter(frame => frame.type === 'output_offer').map(frame => frame.reference.id)).toEqual([hidden.id, hidden.id]);
    await client.destroy(); store = new OutputSnapshots(path.join(root, 'snapshots'));
    client = new OutputFiles(store, 'http://127.0.0.1:3000', value => frames.push(value));
    await client.initialize(); client.connect();
    expect(store.references()[0].id).toBe(hidden.id);
  });

  it('uses immutable bytes when the original worker path is replaced and leaves unselected files hidden', async () => {
    await fs.writeFile(path.join(worker, 'other.txt'), 'unselected bytes');
    const hidden = await store.snapshot(filename(), workerContext());
    await store.snapshot(path.join(worker, 'other.txt'), workerContext());
    await fs.writeFile(filename(), 'replacement worker bytes');
    await client.capture(links(filename()), parentContext());
    expect(store.references().map(ref => ref.id)).toEqual([hidden.id]);
    expect(await read(hidden.id)).toBe('original worker bytes');
  });

  it.each(['messageId', 'threadId', 'generation', 'owner'])('does not promote across a different %s', async field => {
    await store.snapshot(filename(), workerContext()); await fs.rm(worker, { recursive: true });
    const context = { ...parentContext(), [field]: field === 'generation' ? 3 : 'foreign-scope' };
    expect(await client.capture(links(filename()), context)).toMatchObject({ unavailable: 1 });
    expect(store.references()).toEqual([]);
    expect(frames.map(frame => frame.type)).toEqual(['output_discovery']);
  });

  it('does not promote unknown owner provenance', async () => {
    await store.snapshot(filename(), { ...workerContext(), owner: undefined });
    await expect(store.snapshot(filename(), parentContext())).rejects.toThrow('outside');
    expect(store.references()).toEqual([]);
  });

  it('deduplicates the same task identity but rejects multiple worker versions and recycled paths', async () => {
    const first = await store.snapshot(filename(), workerContext());
    expect((await store.snapshot(filename(), workerContext())).id).toBe(first.id);
    await store.snapshot(filename(), { ...workerContext(), taskId: 'sibling-task' });
    await expect(store.snapshot(filename(), parentContext())).rejects.toThrow('ambiguous');
    expect(store.references()).toEqual([]);
  });

  it('rejects multiple versions from one worker task instead of selecting the last path contents', async () => {
    await store.snapshot(filename(), workerContext());
    await fs.writeFile(filename(), 'different worker version');
    await store.snapshot(filename(), workerContext());
    await expect(store.snapshot(filename(), parentContext())).rejects.toThrow('ambiguous');
    expect(store.references()).toEqual([]);
  });

  it('promotes an exact verified export across commands while preserving byte identity and expiry', async () => {
    const hidden = await store.snapshot(filename(), workerContext());
    const exported = { file: path.join(root, 'exported-report'), path: 'report.txt', taskId: 'worker-task', bytes: hidden.size, sha256: hidden.sha256 };
    await fs.rm(worker, { recursive: true });
    // The verified native artifact file need not be reread: the immutable snapshot already has these bytes.
    const context = { ...parentContext(), messageId: 'later-command', generation: 3, exports: [exported] };
    const selected = await store.snapshot(exported.file, context);
    expect(selected).toMatchObject({ id: hidden.id, messageId: 'later-command', sha256: hidden.sha256, expiresAt: hidden.expiresAt });
    expect(await read(selected.id)).toBe('original worker bytes');
    expect((await store.snapshot(exported.file, context)).id).toBe(hidden.id);
    await client.destroy(); store = new OutputSnapshots(path.join(root, 'snapshots'));
    client = new OutputFiles(store, 'http://127.0.0.1:3000', value => frames.push(value));
    await client.initialize(); client.connect();
    expect(store.references()).toEqual([selected]);
    expect(await read(selected.id)).toBe('original worker bytes');
  });

  it.each(['owner', 'threadId'])('never uses verified export provenance across another %s', async field => {
    const hidden = await store.snapshot(filename(), workerContext());
    const exported = { file: path.join(root, 'verified-export'), path: 'report.txt', taskId: 'worker-task', bytes: hidden.size, sha256: hidden.sha256 };
    await fs.rm(worker, { recursive: true });
    await expect(store.snapshot(exported.file, { ...parentContext(), [field]: 'foreign', exports: [exported] })).rejects.toThrow();
    expect(store.references()).toEqual([]);
  });

  it('uses task-bound export provenance to disambiguate sibling worker paths', async () => {
    const first = await store.snapshot(filename(), workerContext());
    await store.snapshot(filename(), { ...workerContext(), taskId: 'sibling' });
    const exported = { file: path.join(root, 'verified-export'), path: 'report.txt', taskId: 'worker-task', bytes: first.size, sha256: first.sha256 };
    await fs.rm(worker, { recursive: true });
    expect((await store.snapshot(exported.file, { ...parentContext(), exports: [exported] })).id).toBe(first.id);
    expect(store.references()).toHaveLength(1);
  });

  it.each(['taskId', 'path', 'sha256', 'bytes'])('rejects a mismatched export %s', async field => {
    const hidden = await store.snapshot(filename(), workerContext());
    const exported: any = { file: path.join(root, 'exported-report'), path: 'report.txt', taskId: 'worker-task', bytes: hidden.size, sha256: hidden.sha256 };
    exported[field] = field === 'bytes' ? hidden.size + 1 : field === 'sha256' ? 'f'.repeat(64) : 'foreign';
    await fs.rm(worker, { recursive: true });
    await expect(store.snapshot(exported.file, { ...parentContext(), exports: [exported] })).rejects.toThrow();
    expect(store.references()).toEqual([]);
  });

  it('keeps a failed publication private and allows a safe retry of the same receipt', async () => {
    const hidden = await store.snapshot(filename(), workerContext());
    const disk = vi.spyOn(durability, 'durableJson').mockRejectedValueOnce(new Error('Synthetic disk error'));
    expect(await client.capture(links(filename()), parentContext())).toMatchObject({ unavailable: 1 });
    expect(store.references()).toEqual([]); await expect(read(hidden.id)).rejects.toThrow('not published');
    disk.mockRestore();
    await client.capture(links(filename()), parentContext());
    expect(store.references()[0].id).toBe(hidden.id);
    expect(frames.filter(frame => frame.type === 'output_offer')).toHaveLength(1);
  });

  it('validates immutable private bytes before publishing', async () => {
    const hidden = await store.snapshot(filename(), workerContext());
    await fs.writeFile(store.filename(hidden.id), 'corrupted snapshot');
    await expect(store.snapshot(filename(), parentContext())).rejects.toThrow('changed');
    expect(store.references()).toEqual([]);
  });

  it('counts hidden receipts against quota and expires them with their bytes', async () => {
    const hidden = await store.snapshot(filename(), workerContext());
    for (let i = 1; i < OUTPUT_LIMITS.references; i++) {
      await store.snapshot(filename(), { ...workerContext(), taskId: `worker-${i}` });
    }
    await expect(store.snapshot(filename(), { ...workerContext(), taskId: 'over-quota' })).rejects.toThrow('quota');
    vi.spyOn(Date, 'now').mockReturnValue(hidden.expiresAt + OUTPUT_LIMITS.ttl);
    await store.cleanup(); expect(store.references()).toEqual([]);
    expect(await fs.readdir(store.root)).toEqual([]);
  });

  it('applies the configured size cap when publishing a previously hidden receipt', async () => {
    await store.snapshot(filename(), workerContext()); await client.destroy();
    store = new OutputSnapshots(path.join(root, 'snapshots'), { maxBytes: 5 });
    client = new OutputFiles(store, 'http://127.0.0.1:3000', value => frames.push(value));
    await client.initialize(); client.connect();
    await expect(store.snapshot(filename(), parentContext())).rejects.toThrow('limit');
    expect(store.references()).toEqual([]);
  });

  it('does not publish after expiry while immutable bytes are being validated', async () => {
    const hidden = await store.snapshot(filename(), workerContext());
    const use = (store as any).use.bind(store);
    vi.spyOn(store as any, 'use').mockImplementationOnce(async (record: any, callback: any) => use(record, async (...args: any[]) => {
      vi.spyOn(Date, 'now').mockReturnValue(hidden.expiresAt + 1); await callback(...args);
    }));
    await expect(store.snapshot(filename(), parentContext())).rejects.toThrow('expired');
    expect(store.references()).toEqual([]);
  });

  it('fails closed on an oversized restarted inventory without publishing or deleting receipts', async () => {
    const hidden = await store.snapshot(filename(), workerContext());
    const metadata = JSON.parse(await fs.readFile(path.join(store.root, `${hidden.id}.worker.json`), 'utf8'));
    await client.destroy();
    for (let i = 0; i < OUTPUT_LIMITS.references; i++) {
      const id = createHash('sha256').update(`synthetic-${i}`).digest('hex');
      await durability.durableJson(path.join(root, 'snapshots', `${id}.worker.json`), { ...metadata, reference: { ...metadata.reference, id } });
    }
    store = new OutputSnapshots(path.join(root, 'snapshots'));
    client = new OutputFiles(store, 'http://127.0.0.1:3000', value => frames.push(value));
    await expect(client.initialize()).rejects.toThrow('quota');
    expect(store.references()).toEqual([]);
    expect((await fs.readdir(path.join(root, 'snapshots'))).filter(name => name.endsWith('.json'))).toHaveLength(101);
  });

  it('preserves public legacy receipts, strips unknown wire fields and rejects malformed visibility', async () => {
    const existing = await store.snapshot(filename(), { ...parentContext(), cwd: worker });
    const receipt = path.join(store.root, `${existing.id}.json`);
    await client.destroy();
    const record = JSON.parse(await fs.readFile(receipt, 'utf8')); delete record.publication;
    record.reference.privatePath = 'private-path-sentinel';
    await durability.durableJson(receipt, record);
    store = new OutputSnapshots(path.join(root, 'snapshots')); client = new OutputFiles(store, 'http://127.0.0.1:3000', value => frames.push(value));
    await client.initialize(); client.connect();
    expect(store.references()[0].id).toBe(existing.id); expect(JSON.stringify(frames)).not.toContain('private-path-sentinel');
    expect(await read(existing.id)).toBe('original worker bytes');
    await client.destroy(); record.publication = { version: 1, visible: false };
    await durability.durableJson(receipt, record);
    store = new OutputSnapshots(path.join(root, 'snapshots')); client = new OutputFiles(store, 'http://127.0.0.1:3000', value => frames.push(value));
    await client.initialize(); expect(store.references()).toEqual([]);
  });

  it('preserves legacy worker receipts that may already have offered cards', async () => {
    const hidden = await store.snapshot(filename(), workerContext());
    const privateMetadata = path.join(store.root, `${hidden.id}.worker.json`);
    const record = JSON.parse(await fs.readFile(privateMetadata, 'utf8'));
    const privateBytes = store.filename(hidden.id);
    await client.destroy(); delete record.publication;
    await fs.rename(privateBytes, path.join(root, 'snapshots', `${hidden.id}.bin`));
    await durability.durableJson(path.join(root, 'snapshots', `${hidden.id}.json`), record); await fs.unlink(privateMetadata);
    store = new OutputSnapshots(path.join(root, 'snapshots'));
    client = new OutputFiles(store, 'http://127.0.0.1:3000', value => frames.push(value));
    await client.initialize(); client.connect();
    expect(store.references()[0].id).toBe(hidden.id); expect(await read(hidden.id)).toBe('original worker bytes');
  });

  it('keeps coordinator unavailable and capped discovery visible', async () => {
    const input = links(path.join(parent, 'missing'));
    input.append(' '.repeat(OUTPUT_LIMITS.text));
    expect(await client.capture(input, parentContext())).toMatchObject({ unavailable: 1, omitted: true });
    expect(frames).toEqual([expect.objectContaining({ type: 'output_discovery', unavailable: 1, omitted: true })]);
  });

  it('uploads selected old bytes through the existing bounded transport after cleanup', async () => {
    await client.destroy(); store = new OutputSnapshots(path.join(root, 'snapshots')); await store.initialize();
    let received = Buffer.alloc(0);
    const server = http.createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received = Buffer.concat(chunks); response.writeHead(204).end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    client = new OutputFiles(store, `http://127.0.0.1:${(server.address() as any).port}`, value => frames.push(value)); client.connect();
    try {
      const hidden = await store.snapshot(filename(), workerContext()); await fs.rm(worker, { recursive: true });
      await client.capture(links(filename()), parentContext());
      client.handle({ type: 'output_grant', id: hidden.id, transferId: 'b'.repeat(64), token: 'c'.repeat(64), expiresAt: Date.now() + 10_000 });
      await Promise.allSettled([...(client as any).tasks]);
      expect(received.toString()).toBe('original worker bytes');
      expect(createHash('sha256').update(received).digest('hex')).toBe(hidden.sha256);
      expect(frames.some(frame => frame.type === 'output_transfer_failed')).toBe(false);
    } finally { await client.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
