import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import http from 'http';
import { createHash } from 'crypto';
import { OutputLinks, localDestination } from '../../src/output/OutputLinks';
import { OutputSnapshots, openOutputFile } from '../../src/output/OutputSnapshots';
import { OutputFiles } from '../../src/output/OutputFiles';
import { OUTPUT_LIMITS, validReference } from '../../src/output/Protocol';
import { durableJson } from '../../src/output/Durable';
import { nativeBindings } from '../../src/native/NativeBindings';

let root: string, cwd: string, store: OutputSnapshots;
const context = () => ({ messageId: 'reply', threadId: 'thread', taskId: 'task', generation: 0, cwd, source: 'workspace' as const });
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'output-test-')));
  cwd = path.join(root, 'workspace'); await fs.mkdir(cwd);
  const home = path.join(root, 'home'); await fs.mkdir(home); vi.spyOn(os, 'homedir').mockReturnValue(home);
  store = new OutputSnapshots(path.join(root, 'snapshots')); await store.initialize();
});
afterEach(async () => { await store.destroy(); vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

describe('deterministic output links', () => {
  it('assembles fragments and reference links without examples, images, URLs or bare paths', () => {
    const links = new OutputLinks();
    links.append('[result](<report '); links.append('one.csv>)\n[ref][x]\n\n[x]: data.json\n\n![image](secret.png) ` [code](secret.txt) `\n```\n[example](secret)\n```\nhttps://example.com bare.txt');
    expect(links.finish('[again](data.json) [web](https://example.com)')).toEqual({ paths: ['report one.csv', 'data.json'], omitted: false });
  });
  it('handles line anchors and platform path rules without treating POSIX colon names as code locations', () => {
    expect(localDestination('/report.md#L12-L20')).toBe('/report.md');
    expect(localDestination('report:12', path.posix as typeof path)).toBeUndefined();
    expect(localDestination('./report:12', path.posix as typeof path)).toBe('./report:12');
    expect(localDestination('C:/work/report.txt:12', path.win32 as typeof path)).toBe('C:/work/report.txt');
    expect(localDestination('C:/work/file:stream', path.win32 as typeof path)).toBeUndefined();
    for (const value of ['//server/file', '\\\\server\\file', 'file:///report', '%00secret', '%zz', 'https://example.com']) expect(localDestination(value)).toBeUndefined();
  });
  it('uses exact attachment titles on streamed and reference links without guessing from file types or labels', () => {
    const links = new OutputLinks();
    links.append('[Download](source.go) [Attachment](source.ts "Attachment") [Report](<report ');
    links.append('one.md> "attachment")\n[source][selected]\n\n[selected]: deliverable.go "attachment"');
    expect(links.finish(undefined, 'attachments')).toEqual({ paths: ['report one.md', 'deliverable.go'], omitted: false });
  });
  it.each([{ platform: 'POSIX', flavor: path.posix }, { platform: 'Windows', flavor: path.win32 }])(
    'distinguishes encoded filename hashes from citation fragments on $platform', ({ flavor }) => {
      expect(localDestination('./report%23notes.go', flavor as typeof path, true)).toBe('./report#notes.go');
      expect(localDestination('./report.go%23L12', flavor as typeof path, true)).toBe('./report.go#L12');
      expect(localDestination('./report.go#L12', flavor as typeof path, true)).toBeUndefined();
      expect(localDestination('./report.go:12', flavor as typeof path, true)).toBeUndefined();
      expect(localDestination('//server/file', flavor as typeof path, true)).toBeUndefined();
    });
  it('retains the Windows alternate-stream guard for explicit attachments', () => {
    expect(localDestination('C:/work/report.go:stream', path.win32 as typeof path, true)).toBeUndefined();
  });
  it('does not carry an ordinary capped citation scan into a later attachment selection', () => {
    const links = new OutputLinks(); links.append('[source](source.go)' + ' '.repeat(OUTPUT_LIMITS.text));
    expect(links.finish(undefined, 'attachments')).toEqual({ paths: [], omitted: false });
    links.append('[Report](report.md "attachment")');
    expect(links.finish(undefined, 'attachments')).toEqual({ paths: ['report.md'], omitted: false });
  });
  it('caps input and candidates with an explicit omission marker', () => {
    const links = new OutputLinks(); links.append(Array.from({ length: 25 }, (_, i) => `[a](./${i}.txt)`).join(' '));
    expect(links.finish().paths).toHaveLength(16);
    const huge = new OutputLinks(); huge.append(' '.repeat(OUTPUT_LIMITS.text + 1)); expect(huge.finish().omitted).toBe(true);
  });
});

describe('authorized durable snapshots', () => {
  it('honors delayed permission loss before content reads and fixes delayed snapshot expiry', async () => {
    await fs.writeFile(path.join(cwd, 'report'), 'current bytes after approval');
    const denied = vi.fn(() => false);
    await expect(store.snapshot('report', { ...context(), current: denied })).rejects.toThrow('stopped');
    expect(store.references()).toHaveLength(0);
    const expiresAt = Date.now() + 30_000;
    const ref = await store.snapshot('report', { ...context(), expiresAt, current: () => true });
    expect(ref.expiresAt).toBe(expiresAt);
    await expect(store.snapshot('report', { ...context(), expiresAt: Date.now() })).rejects.toThrow('stopped');
  });
  it('uses a canonical private store beneath an existing ancestor alias', async () => {
    const alias = path.join(root, 'alias');
    await fs.symlink(cwd, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const aliased = new OutputSnapshots(path.join(alias, 'private', 'snapshots'));
    try {
      await aliased.initialize();
      expect(aliased.root).toBe(path.join(cwd, 'private', 'snapshots'));
      await fs.writeFile(path.join(cwd, 'report'), 'retained output');
      const ref = await aliased.snapshot('report', context());
      let bytes = '';
      await aliased.read(ref.id, async source => { for await (const chunk of source) bytes += chunk.toString(); });
      expect(bytes).toBe('retained output');
    } finally { await aliased.destroy(); }
  });
  it('rejects store replacement before reads, cleanup or new snapshots touch foreign data', async () => {
    await fs.writeFile(path.join(cwd, 'report'), 'owned'); const ref = await store.snapshot('report', context());
    const directory = store.root; await fs.rename(directory, `${directory}-retained`); await fs.mkdir(directory);
    const sentinel = path.join(directory, `${ref.id}.bin`); await fs.writeFile(sentinel, 'foreign');
    const publish = vi.fn();
    await expect(store.read(ref.id, publish)).rejects.toThrow('identity changed'); expect(publish).not.toHaveBeenCalled();
    ref.expiresAt = Date.now() - 1;
    await expect(store.cleanup()).rejects.toThrow('identity changed');
    await expect(store.snapshot('report', context())).rejects.toThrow('identity changed');
    expect(await fs.readFile(sentinel, 'utf8')).toBe('foreign');
  });
  it('captures immutable bytes, deduplicates a reply, and survives source reclamation/restart', async () => {
    const original = path.join(cwd, 'report.txt'); await fs.writeFile(original, 'stable output');
    const ref = await store.snapshot('report.txt', { ...context(), omitted: true }); expect(validReference(ref)).toBe(true);
    expect(ref.discoveryIncomplete).toBe(true);
    expect((await store.snapshot(original, context())).id).toBe(ref.id);
    await fs.rm(cwd, { recursive: true }); await store.destroy();
    store = new OutputSnapshots(path.join(root, 'snapshots')); await store.initialize();
    const chunks: Buffer[] = []; await store.read(ref.id, async bytes => { for await (const part of bytes) chunks.push(part); });
    expect(Buffer.concat(chunks).toString()).toBe('stable output');
    expect(ref.sha256).toBe(createHash('sha256').update('stable output').digest('hex'));
  });
  it('rejects unauthorized, hidden, empty, hard-linked and linked paths', async () => {
    await fs.writeFile(path.join(root, 'outside.txt'), 'private');
    await fs.writeFile(path.join(cwd, '.env'), 'private'); await fs.writeFile(path.join(cwd, 'empty'), '');
    await fs.writeFile(path.join(cwd, 'original'), 'data'); await fs.link(path.join(cwd, 'original'), path.join(cwd, 'hard'));
    for (const file of ['../outside.txt', '.env', 'empty', 'hard']) await expect(store.snapshot(file, context())).rejects.toThrow();
    await fs.symlink(root, path.join(cwd, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(store.snapshot('linked/outside.txt', context())).rejects.toThrow();
    expect(store.references()).toHaveLength(0);
  });
  it('supports explicit extra roots but never grants a home or volume', async () => {
    const extra = path.join(root, '.exports'); await fs.mkdir(extra); await fs.writeFile(path.join(extra, 'file'), 'export');
    const allowed = new OutputSnapshots(path.join(root, 'extra-store'), { allowedRoots: [extra] }); await allowed.initialize();
    try { expect((await allowed.snapshot(path.join(extra, 'file'), context())).size).toBe(6); }
    finally { await allowed.destroy(); }
    await expect(store.snapshot(path.join(extra, 'file'), context())).rejects.toThrow();
  });
  it('copies exact verified legacy exports into independent snapshots and checks their hashes', async () => {
    const directory = path.join(root, '.durable-exports'); await fs.mkdir(directory);
    const bytes = Buffer.from('exported artifact'); const digest = createHash('sha256').update(bytes).digest('hex');
    const file = path.join(directory, digest); await fs.writeFile(file, bytes);
    await expect(store.snapshot(file, context())).rejects.toThrow();
    const exports = [{ file, path: 'results/report.csv', sha256: digest, bytes: bytes.length, taskId: 'original-worker' }];
    const ref = await store.snapshot(file, { ...context(), exports });
    expect(ref).toMatchObject({ name: 'report.csv', source: 'export', taskId: 'original-worker', sha256: digest });
    await fs.writeFile(file, Buffer.alloc(bytes.length, 1));
    await expect(store.snapshot(file, { ...context(), messageId: 'later-reply', exports })).rejects.toThrow('changed');
  });

  it('blocks credential roots even when selected as cwd or explicitly allowed', async () => {
    const ssh = path.join(root, 'home', '.ssh'); await fs.mkdir(ssh); await fs.writeFile(path.join(ssh, 'settings'), 'private');
    await expect(store.snapshot('settings', { ...context(), cwd: ssh })).rejects.toThrow();
    const application = path.join(root, 'home', '.remote-cli'); await fs.mkdir(application); await fs.writeFile(path.join(application, 'config.json'), '{}');
    await expect(store.snapshot('config.json', { ...context(), cwd: application })).rejects.toThrow('Application state');
    expect(() => new OutputSnapshots(root, { allowedRoots: ['relative'] })).toThrow('policy');
  });

  it.each([16 * 1024 * 1024, 16 * 1024 * 1024 + 1, 20 * 1024 * 1024])('accepts %i bytes without changing legacy export receipts', async size => {
    const file = await fs.open(path.join(cwd, 'large.bin'), 'w'); await file.truncate(size); await file.close();
    expect((await store.snapshot('large.bin', context())).size).toBe(size);
  });
  it('enforces downward caps, total quotas and count limits', async () => {
    await fs.writeFile(path.join(cwd, 'file'), '1234');
    const small = new OutputSnapshots(path.join(root, 'small'), { maxBytes: 3 }); await small.initialize();
    try { await expect(small.snapshot('file', context())).rejects.toThrow('limit'); } finally { await small.destroy(); }
    expect(() => new OutputSnapshots(root, { maxBytes: OUTPUT_LIMITS.file + 1 })).toThrow();
    const records = (store as any).records as Map<string, any>;
    const ref = await store.snapshot('file', context());
    for (let i = 0; i < 100; i++) records.set(String(i), { reference: { ...ref, messageId: 'other' }, identity: 'other' });
    await expect(store.snapshot('file', { ...context(), messageId: 'next' })).rejects.toThrow('quota');
    records.clear();
    const big = await fs.open(path.join(cwd, 'big'), 'w'); await big.truncate(OUTPUT_LIMITS.file + 1); await big.close();
    await expect(store.snapshot('big', context())).rejects.toThrow();
  });
  it('rejects file mutation during anchored reads', async () => {
    await fs.writeFile(path.join(cwd, 'file'), Buffer.alloc(131072, 1));
    const file = openOutputFile(path.join(cwd, 'file')); const chunks = file.chunks();
    try { await chunks.next(); await fs.writeFile(path.join(cwd, 'file'), 'changed'); await expect(chunks.next()).rejects.toThrow(); }
    finally { try { await chunks.return(undefined); } finally { file.close(); } }
  });
  it('protects anchored reads when scope replacement is denied or succeeds', async () => {
    const original = Buffer.alloc(131072, 1), foreign = Buffer.from('foreign sentinel');
    const filename = path.join(cwd, 'file'), moved = `${cwd}-old`, replacement = path.join(root, 'replacement');
    await fs.writeFile(filename, original);
    await fs.mkdir(replacement); await fs.writeFile(path.join(replacement, 'file'), foreign);
    const directoryIdentity = await fs.stat(cwd, { bigint: true });
    const fileIdentity = await fs.stat(filename, { bigint: true });
    const opened = openOutputFile(filename), stream = opened.chunks(), received: Buffer[] = [];
    let denied = false;
    try {
      const first = await stream.next(); expect(first.done).toBe(false); received.push(first.value!);
      try { await fs.rename(cwd, moved); }
      catch (error) {
        // Windows may deny an ancestor rename while descendants are open, even with FILE_SHARE_DELETE.
        // Accept only the observed native denial; unrelated errors must fail this fixture.
        expect(process.platform).toBe('win32');
        expect(error).toMatchObject({ code: 'EPERM', syscall: 'rename', path: cwd, dest: moved });
        denied = true;
      }
      const drain = async () => { for await (const chunk of stream) received.push(chunk); };
      if (denied) {
        await expect(fs.stat(moved)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await fs.stat(cwd, { bigint: true })).toMatchObject({ dev: directoryIdentity.dev, ino: directoryIdentity.ino });
        expect(await fs.stat(filename, { bigint: true })).toMatchObject({ dev: fileIdentity.dev, ino: fileIdentity.ino,
          size: fileIdentity.size, mtimeNs: fileIdentity.mtimeNs });
        await expect(drain()).resolves.toBeUndefined();
        expect(await fs.readFile(filename)).toEqual(original);
        expect(await fs.readFile(path.join(replacement, 'file'))).toEqual(foreign);
      } else {
        await fs.rename(replacement, cwd);
        await expect(drain()).rejects.toThrow('scope changed');
        expect(await fs.readFile(filename)).toEqual(foreign);
      }
      expect(Buffer.concat(received)).toEqual(original);
    } finally { try { await stream.return(undefined); } finally { opened.close(); } }
    if (denied) {
      // All iterator/native handles are closed: the identical rename must now work.
      // This distinguishes handle protection from unrelated filesystem permission failures.
      await fs.rename(cwd, moved); await fs.rename(replacement, cwd);
    }
    expect(await fs.stat(moved, { bigint: true })).toMatchObject({ dev: directoryIdentity.dev, ino: directoryIdentity.ino });
    expect(await fs.stat(path.join(moved, 'file'), { bigint: true })).toMatchObject({ dev: fileIdentity.dev, ino: fileIdentity.ino });
    expect(await fs.readFile(path.join(moved, 'file'))).toEqual(original);
    expect(await fs.readFile(filename)).toEqual(foreign);
  });
  it('rejects changed snapshot bytes before exposing any stream to the network', async () => {
    await fs.writeFile(path.join(cwd, 'file'), 'original'); const ref = await store.snapshot('file', context());
    await fs.writeFile(store.filename(ref.id), 'modified'); const publish = vi.fn();
    await expect(store.read(ref.id, publish)).rejects.toThrow('changed'); expect(publish).not.toHaveBeenCalled();
  });

  it('resolves missing numeric code locations while preserving real POSIX colon filenames', async () => {
    await fs.writeFile(path.join(cwd, 'code.ts'), 'source');
    const links = new OutputLinks(); links.append('[code](code.ts:12:3)');
    expect(links.finish().paths).toEqual([process.platform === 'win32' ? 'code.ts' : 'code.ts:12:3']);
    if (process.platform === 'win32') {
      expect(localDestination('code.ts:12:3')).toBe('code.ts');
    } else {
      expect((await store.snapshot('code.ts:12:3', context())).name).toBe('code.ts');
      await fs.writeFile(path.join(cwd, 'real.ts:12'), 'literal');
      expect((await store.snapshot('real.ts:12', context())).name).toBe('real.ts:12');
      const native = nativeBindings(), directory = native.openRoot(cwd);
      try { expect(() => native.openChild(directory, 'real.ts:12', false)).toThrow('Invalid native path component'); }
      finally { native.close(directory); }
      await fs.writeFile(path.join(cwd, 'auth.json'), 'private');
      await expect(store.snapshot('auth.json:12', context())).rejects.toThrow('policy');
    }
  });

  it('expires owned bytes and rejects invalid records and IDs', async () => {
    await fs.writeFile(path.join(cwd, 'file'), 'data'); const ref = await store.snapshot('file', context());
    vi.spyOn(Date, 'now').mockReturnValue(ref.expiresAt + 1); await store.cleanup(); expect(store.references()).toEqual([]);
    await expect(store.read(ref.id, async () => {})).rejects.toThrow(); expect(() => store.filename('../file')).toThrow();
    await durableJson(path.join(store.root, `${'a'.repeat(64)}.json`), { invalid: true });
    await fs.writeFile(path.join(store.root, `${'b'.repeat(64)}.tmp`), 'partial');
    await store.initialize(); expect(store.references()).toEqual([]);
    await expect(fs.stat(path.join(store.root, `${'b'.repeat(64)}.tmp`))).rejects.toThrow();
  });
});

describe('metadata and outbound HTTP', () => {
  it('re-offers after lost registration ACK and uploads only to the configured origin', async () => {
    await fs.writeFile(path.join(cwd, 'report'), 'file payload'); const send = vi.fn();
    let received = ''; const server = http.createServer((req, res) => {
      req.on('data', chunk => { received += chunk; }); req.on('end', () => { res.writeHead(204); res.end(); });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const client = new OutputFiles(store, `ws://127.0.0.1:${(server.address() as any).port}`, send);
    try {
      client.connect(); const links = new OutputLinks(); links.append('[result](report "attachment")'); await client.capture(links, context());
      const offer = send.mock.calls.find(call => call[0].type === 'output_offer')![0];
      client.handle({ type: 'output_registered', id: offer.reference.id });
      client.disconnect(); client.connect(); expect(send.mock.calls.filter(call => call[0].type === 'output_offer')).toHaveLength(2);
      client.handle({ type: 'output_grant', id: offer.reference.id, transferId: 'c'.repeat(64), token: 'd'.repeat(64), expiresAt: Date.now() + 10000 });
      await Promise.allSettled([...(client as any).tasks]); expect(received).toBe('file payload');
      expect(JSON.stringify(send.mock.calls)).not.toContain('file payload');
      client.handle({ type: 'output_grant', id: '../private' }); expect((client as any).active.size).toBe(0);
    } finally { await client.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('fails a rejected upload without leaking file bytes or tokens into status', async () => {
    await fs.writeFile(path.join(cwd, 'report'), 'sentinel-body'); const ref = await store.snapshot('report', context());
    const server = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(403); res.end(); }); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const send = vi.fn();
    const client = new OutputFiles(store, `ws://127.0.0.1:${(server.address() as any).port}`, send);
    try {
      client.connect(); client.handle({ type: 'output_grant', id: ref.id, transferId: 'e'.repeat(64), token: 'f'.repeat(64), expiresAt: Date.now() + 10000 });
      await Promise.allSettled([...(client as any).tasks]); expect(send).toHaveBeenCalledWith({ type: 'output_transfer_failed', transferId: 'e'.repeat(64) });
      expect(JSON.stringify(send.mock.calls)).not.toContain('sentinel-body');
    } finally { await client.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
