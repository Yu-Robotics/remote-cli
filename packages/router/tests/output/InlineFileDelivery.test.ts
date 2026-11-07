import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { InlineFileCards } from '../../src/output/InlineFileCards';
import { OutputTransfers, type OutputDependencies } from '../../src/output/OutputTransfers';
import { OutputFiles } from '../../../cli/src/output/OutputFiles';
import { OutputLinks } from '../../../cli/src/output/OutputLinks';
import { OutputSnapshots } from '../../../cli/src/output/OutputSnapshots';

let root: string, cwd: string, client: OutputFiles, store: OutputSnapshots, transfers: OutputTransfers, cards: InlineFileCards;
let deps: OutputDependencies, owned: boolean, pending: Promise<unknown>[], patches: any[];
const parent = { messageId: 'request', rootId: 'actual-parent', openId: 'owner', deviceId: 'device', epoch: 'epoch', threadId: 'thread' };
const context = () => ({ owner: 'owner', messageId: 'request', taskId: 'request', threadId: 'thread', generation: 2, cwd, source: 'workspace' as const });
const body = JSON.stringify({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'Complete assistant body' }, { tag: 'markdown', content: 'Completed' }] } });
const input = () => { const l = new OutputLinks(); l.append('[Report](./output/report.csv "attachment")'); return l; };
async function settle() {
  for (let i = 0; i < 8; i++) {
    await Promise.allSettled(pending); await transfers.tick();
    await Promise.allSettled([...(transfers as any).running.values(), ...(transfers as any).presentations.values(), ...(transfers as any).entryWork.values()]);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'inline-delivery-'))); vi.spyOn(os, 'homedir').mockReturnValue(root);
  cwd = path.join(root, 'workspace'); await fs.mkdir(path.join(cwd, 'output'), { recursive: true }); await fs.writeFile(path.join(cwd, 'output/report.csv'), 'test,value\n1,2\n');
  pending = []; patches = []; owned = true; store = new OutputSnapshots(path.join(root, 'snapshots'));
  client = new OutputFiles(store, 'http://127.0.0.1:3000', (frame: any) => {
    if (frame.type === 'output_offer') pending.push(transfers.offer('device', frame.reference));
  }); await client.initialize(); client.connect();
  deps = {
    session: () => ({ id: 'session', openId: 'owner' }), owns: async () => owned,
    create: vi.fn(async () => 'unexpected-standalone'), patch: vi.fn(async () => {}),
    inline: messageId => cards.refresh(messageId), parentAllowed: (...args) => cards.allows(...args),
    send: (_device, frame: any) => {
      if (frame.type === 'output_registered') client.handle(frame);
      if (frame.type === 'output_grant') pending.push((async () => {
        const parts: Buffer[] = []; await store.read((transfers as any).state.jobs[0].refId, async bytes => { for await (const chunk of bytes) parts.push(chunk); });
        await transfers.receive({ get: () => `Bearer ${frame.token}`, req: Readable.from(parts), status: 0 } as any, frame.transferId);
      })());
    },
    upload: vi.fn(async filename => { expect(await fs.readFile(filename, 'utf8')).toBe('test,value\n1,2\n'); return 'file-key'; }),
    sendFile: vi.fn(async () => 'file-message'),
  };
  transfers = new OutputTransfers(path.join(root, 'transfers'), deps); await transfers.initialize();
  cards = new InlineFileCards(path.join(root, 'parents'), { owns: async () => owned, rows: id => transfers.inlineRows(id), patch: async (cardId, content) => { patches.push({ cardId, content: JSON.parse(content) }); } });
  await cards.admit(parent); await transfers.admitSource({ ...parent });
});
afterEach(async () => { await settle(); await transfers.destroy(); await cards.destroy(); await client.destroy(); vi.useRealTimers(); vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

describe('manual retrieval from the original execution card', () => {
  it.each(['before final', 'after final'])('captures a valid workspace artifact %s and delivers only after an authorized click', async when => {
    if (when === 'after final') { cards.remember('final-parent', parent.rootId, body); await cards.bind(parent.rootId, 'final-parent'); }
    await client.capture(input(), context()); await settle();
    expect(deps.create).not.toHaveBeenCalled(); expect(deps.sendFile).not.toHaveBeenCalled(); expect((transfers as any).state.jobs).toEqual([]);
    if (when === 'before final') { expect(patches).toEqual([]); cards.remember('final-parent', parent.rootId, body); await cards.bind(parent.rootId, 'final-parent'); }
    const id = store.references()[0].id;
    expect(await transfers.click('owner', parent.messageId, { id, op: 'get' })).toContain('unavailable');
    expect(await transfers.click('foreign', 'final-parent', { id, op: 'get' })).toContain('unavailable');
    expect(await transfers.click('owner', 'final-parent', { id, op: 'get' })).toContain('accepted');
    await settle(); expect(deps.sendFile).toHaveBeenCalledOnce(); expect(deps.create).not.toHaveBeenCalled();
    expect(patches.every(p => p.cardId === 'final-parent')).toBe(true);
    expect(patches.at(-1).content.body.elements.slice(0, -1)).toEqual(JSON.parse(body).body.elements);
    expect(JSON.stringify(patches.at(-1))).toContain('File already delivered');
  });
  it.each(['other-owner', 'sibling-device', 'epoch', 'thread', 'generation'])('holds orphan reference metadata and callbacks for a mismatched %s parent', async mismatch => {
    await client.capture(input(), context()); await settle();
    await cards.destroy(); await fs.rm(path.join(root, 'parents'), { recursive: true }); patches = [];
    const foreign = { ...parent, rootId: 'foreign-root',
      ...(mismatch === 'other-owner' ? { openId: 'other-owner', deviceId: 'other-device' } : {}),
      ...(mismatch === 'sibling-device' ? { deviceId: 'other-device' } : {}),
      ...(mismatch === 'epoch' ? { epoch: 'other-epoch' } : {}),
      ...(mismatch === 'thread' ? { threadId: 'other-thread' } : {}),
      ...(mismatch === 'generation' ? { generation: 3 } : {}),
    };
    cards = new InlineFileCards(path.join(root, 'parents'), { owns: async () => owned,
      rows: identity => transfers.inlineRows(identity), patch: async (cardId, content) => { patches.push({ cardId, content: JSON.parse(content) }); } });
    await cards.admit(foreign);
    if (mismatch === 'generation') await cards.hints(foreign.deviceId, { messageId: parent.messageId, threadId: parent.threadId, generation: 3, names: ['another.csv'] }, 'ready');
    cards.remember('foreign-final', foreign.rootId, body); await cards.bind(foreign.rootId, 'foreign-final');
    expect(JSON.stringify(patches)).not.toContain('report.csv');
    const id = store.references()[0].id;
    expect(await transfers.click(foreign.openId, 'foreign-final', { id, op: 'get' })).toContain('unavailable');
    expect((transfers as any).state.jobs).toEqual([]); expect(deps.sendFile).not.toHaveBeenCalled();
  });

  it('denies an original-reference click from an orphan sibling-device card even for the same user', async () => {
    await client.capture(input(), context()); await settle();
    await cards.destroy(); await fs.rm(path.join(root, 'parents'), { recursive: true }); patches = [];
    const sibling = { ...parent, deviceId: 'sibling', rootId: 'sibling-root' };
    cards = new InlineFileCards(path.join(root, 'parents'), { owns: async () => owned,
      rows: identity => transfers.inlineRows(identity), patch: async (cardId, content) => { patches.push({ cardId, content: JSON.parse(content) }); } });
    await cards.admit(sibling); cards.remember('sibling-card', sibling.rootId, body); await cards.bind(sibling.rootId, 'sibling-card');
    expect(await transfers.click('owner', 'sibling-card', { id: store.references()[0].id, op: 'get' })).toContain('unavailable');
    expect((transfers as any).state.jobs).toEqual([]); expect(deps.sendFile).not.toHaveBeenCalled();
  });

  it('keeps the parent usable until the fixed later snapshot expiry without sliding on restart or clicks', async () => {
    const admitted = Date.now(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(admitted + 2 * 60 * 60_000);
    await client.capture(input(), context()); await settle();
    cards.remember('final-parent', parent.rootId, body); await cards.bind(parent.rootId, 'final-parent');
    const reference = store.references()[0], fixedExpiry = reference.expiresAt;
    await cards.destroy(); cards = new InlineFileCards(path.join(root, 'parents'), { owns: async () => owned,
      rows: identity => transfers.inlineRows(identity), patch: async (cardId, content) => { patches.push({ cardId, content: JSON.parse(content) }); } });
    vi.setSystemTime(admitted + 25 * 60 * 60_000);
    expect(fixedExpiry).toBeGreaterThan(Date.now());
    expect(await transfers.click('owner', 'final-parent', { id: reference.id, op: 'get' })).toContain('accepted');
    expect((cards as any).parents.get('request').expiresAt).toBe(fixedExpiry);
    await settle(); vi.setSystemTime(fixedExpiry + 1);
    expect(await transfers.click('owner', 'final-parent', { id: reference.id, op: 'get' })).toContain('unavailable');
    expect(reference.expiresAt).toBe(fixedExpiry);
  });

  it('keeps disabled hints display-only and rejects forged retrieval callbacks without candidate I/O', async () => {
    client.disable(); const snapshot = vi.spyOn(store, 'snapshot');
    await client.capture(input(), context()); expect(snapshot).not.toHaveBeenCalled();
    await cards.hints('device', { messageId: 'request', threadId: 'thread', generation: 2, names: ['report.csv'] }, 'approval');
    cards.remember('final-parent', parent.rootId, body); await cards.bind(parent.rootId, 'final-parent');
    expect(JSON.stringify(patches.at(-1))).toContain('File approval required');
    expect(await transfers.click('owner', 'final-parent', { id: 'a'.repeat(64), op: 'get' })).toContain('unavailable');
    expect(deps.create).not.toHaveBeenCalled(); expect(deps.sendFile).not.toHaveBeenCalled(); expect((transfers as any).state.jobs).toEqual([]);
  });
  it('offers bounded retry on the same parent after a confirmed failure without duplicate entry or progress cards', async () => {
    await client.capture(input(), context()); await settle(); cards.remember('final-parent', parent.rootId, body); await cards.bind(parent.rootId, 'final-parent');
    deps.upload = vi.fn().mockRejectedValueOnce(new Error('synthetic upload unavailable')).mockResolvedValue('file-key');
    const id = store.references()[0].id; await transfers.click('owner', 'final-parent', { id, op: 'get' }); await settle();
    const job = (transfers as any).state.jobs[0]; expect(job.state).toBe('failed');
    expect(JSON.stringify(patches.at(-1))).toContain('Retry');
    expect(await transfers.click('owner', 'wrong-parent', { id, op: 'retry', rev: job.revision })).toContain('unavailable');
    expect(await transfers.click('owner', 'final-parent', { id, op: 'retry', rev: job.revision })).toContain('accepted'); await settle();
    expect(deps.sendFile).toHaveBeenCalledOnce(); expect(deps.create).not.toHaveBeenCalled();
    expect((transfers as any).state.jobs).toHaveLength(1);
  });

  it('preserves original-device offline queueing while ownership changes revoke access', async () => {
    await client.capture(input(), context()); await settle(); cards.remember('final-parent', parent.rootId, body); await cards.bind(parent.rootId, 'final-parent');
    deps.session = () => undefined;
    const id = store.references()[0].id; await transfers.click('owner', 'final-parent', { id, op: 'get' }); await settle();
    expect((transfers as any).state.jobs[0].state).toBe('waiting-device'); expect(deps.sendFile).not.toHaveBeenCalled();
    owned = false; await settle(); expect((transfers as any).state.jobs[0].state).toBe('revoked');
    expect(await transfers.click('owner', 'final-parent', { id, op: 'get' })).toContain('unavailable');
  });
});
