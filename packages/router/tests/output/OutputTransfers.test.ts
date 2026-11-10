import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { Readable } from 'stream';
import { createHash } from 'crypto';
import Koa from 'koa';
import { WebSocket, WebSocketServer } from 'ws';
import { once } from 'events';
import { OutputTransfers, OutputApiRejection, OutputDependencies } from '../../src/output/OutputTransfers';
import { OutputReference, OUTPUT_LIMITS } from '../../src/output/Protocol';
import { outputFileEntryCard } from '../../src/output/OutputFileCards';
import { durableJson } from '../../src/output/Durable';
import { OutputSnapshots } from '../../../cli/src/output/OutputSnapshots';
import { OutputFiles } from '../../../cli/src/output/OutputFiles';

let root: string, transfers: OutputTransfers, deps: OutputDependencies;
let session: { id: string; openId: string } | undefined, owned: boolean, payload: Buffer;
let receiving: Promise<void>[];
const id = 'a'.repeat(64);
const reference = (): OutputReference => ({ id, messageId: 'reply', threadId: 'thread', taskId: 'task', generation: 2,
  name: 'report.csv', source: 'worker', size: payload.length, sha256: createHash('sha256').update(payload).digest('hex'), expiresAt: Date.now() + OUTPUT_LIMITS.ttl });
const state = () => (transfers as any).state;
function ctx(token: string, data: Buffer): any { return { get: () => `Bearer ${token}`, req: Readable.from([data]), status: 0 }; }
async function entry(ref = reference()): Promise<void> {
  await transfers.admitSource({ messageId: ref.messageId, deviceId: 'device', openId: 'user', threadId: 'thread', epoch: 'owner-epoch' });
  await transfers.offer('device', ref); await Promise.allSettled([...(transfers as any).entryWork.values()]);
  // Synthetic receipts represent cards published by older releases, not new entry creation.
  const saved = state().references.find((r: any) => r.reference.id === ref.id);
  if (saved && !saved.card) {
    const content = outputFileEntryCard(ref), uuid = `legacy-${ref.id.slice(0, 16)}`;
    saved.card = { id: await deps.create('user', content, uuid), uuid, content, firstAt: Date.now(), state: 'known' };
    await (transfers as any).save();
  }
}
async function click(): Promise<string> { return transfers.click('user', state().references[0].card.id, { id, op: 'get' }); }
async function drain(): Promise<void> {
  // Drain admitted schedulers, network fixtures and presentation work, rather than teardown racing them.
  for (let i = 0; i < 12; i++) {
    await transfers.tick(); await new Promise<void>(resolve => setImmediate(resolve));
    await Promise.allSettled([...receiving, ...(transfers as any).running.values(), ...(transfers as any).presentations.values()]);
    if (!(transfers as any).ticking && !(transfers as any).running.size && !(transfers as any).presentations.size) break;
  }
}
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'output-router-')));
  session = { id: 'connection-1', openId: 'user' }; owned = true; payload = Buffer.from('private-file-sentinel'); receiving = [];
  let cards = 0;
  deps = {
    session: () => session, owns: async () => owned,
    send: vi.fn((_device, message: any) => {
      if (message.type === 'output_grant') receiving.push(transfers.receive(ctx(message.token, payload), message.transferId));
    }),
    create: vi.fn(async () => `card-${++cards}`), patch: vi.fn(async () => {}),
    upload: vi.fn(async file => { expect(await fs.readFile(file)).toEqual(payload); return 'file-key'; }),
    sendFile: vi.fn(async () => 'file-message'),
  };
  transfers = new OutputTransfers(path.join(root, 'router'), deps); await transfers.initialize();
});
afterEach(async () => { await transfers.destroy(); await Promise.allSettled(receiving); vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

describe('durable registration and independent cards', () => {
  it('carries only an exact unverified source across first-key approval and rejects existing references', async () => {
    const owner = { messageId: 'reply', deviceId: 'device', openId: 'user', threadId: 'thread', generation: 2, epoch: 'owner-epoch' };
    await transfers.admitSource(owner);
    expect(await transfers.migrateApprovalSource({ ...owner, threadId: 'foreign' }, 'approved')).toBe(false);
    expect(await transfers.migrateApprovalSource(owner, 'approved')).toBe(true);
    expect(state().sources[0]).toMatchObject({ ...owner, epoch: 'approved' });
    await transfers.offer('device', reference());
    expect(state().references).toHaveLength(1);
    expect(await transfers.migrateApprovalSource({ ...owner, epoch: 'approved' }, 'another')).toBe(false);
    owned = false;
    expect(await transfers.migrateApprovalSource({ ...owner, messageId: 'another-reply' }, 'approved')).toBe(false);
  });
  it('persists and restarts output receipts beneath an existing ancestor alias', async () => {
    const alias = path.join(root, 'alias');
    await fs.symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await transfers.destroy();
    transfers = new OutputTransfers(path.join(alias, 'private', 'spool'), deps);
    await transfers.initialize(); await entry();
    const original = state().references[0].card.id;
    await transfers.destroy(); transfers = new OutputTransfers(path.join(alias, 'private', 'spool'), deps);
    await transfers.initialize();
    expect(state().references[0].card.id).toBe(original);
    expect(await transfers.click('user', original, { id, op: 'get' })).toBe('File retrieval accepted.');
    await drain(); expect(deps.sendFile).toHaveBeenCalledOnce();
  });
  it('rejects replaced spool roots before receipt writes or cleanup affect foreign files', async () => {
    const directory = path.join(root, 'router');
    await fs.rename(directory, `${directory}-retained`); await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'state.json'), 'foreign receipt');
    const sentinel = path.join(directory, `${'e'.repeat(64)}.bin`); await fs.writeFile(sentinel, 'foreign bytes');
    await expect(transfers.admitSource({ messageId: 'reply', deviceId: 'device', openId: 'user', epoch: 'owner-epoch' })).rejects.toThrow('identity changed');
    await expect((transfers as any).cleanup()).rejects.toThrow('identity changed');
    expect(await fs.readFile(path.join(directory, 'state.json'), 'utf8')).toBe('foreign receipt');
    expect(await fs.readFile(sentinel, 'utf8')).toBe('foreign bytes');
  });
  it('admits only a known source, exact metadata, authenticated original device and owner', async () => {
    await transfers.offer('device', reference()); expect(state().references).toEqual([]);
    await entry(); const original = state().references[0];
    await transfers.offer('device', { ...original.reference, name: 'changed' });
    expect(state().references[0]).toBe(original); expect(deps.create).toHaveBeenCalledTimes(1);
    expect(await transfers.click('other', original.card.id, { id, op: 'get' })).toContain('unavailable');
    expect(await transfers.click('user', 'wrong-card', { id, op: 'get' })).toContain('unavailable');
    owned = false; expect(await click()).toContain('unavailable'); expect(state().jobs).toHaveLength(0);
    await expect(transfers.admitSource({ messageId: 'reply', deviceId: 'foreign', openId: 'user', epoch: 'owner-epoch' })).rejects.toThrow('conflict');
  });
  it('keeps historical entry clicks usable with their legacy progress card after inline support is enabled', async () => {
    await entry(); deps.inline = vi.fn(async () => {}); const entryId = state().references[0].card.id;
    const entryCard = JSON.parse((deps.create as any).mock.calls[0][1]);
    expect(entryCard.header.template).toBe('blue');
    expect(entryCard.body.elements[0]).toEqual({ tag: 'div', text: { tag: 'plain_text', content: 'report.csv' } });
    const get = entryCard.body.elements.find((element: any) => element.tag === 'button');
    expect(get.type).toBe('primary');
    const action = get.behaviors[0].value;
    expect(action).toEqual({ action: 'output_file', id, op: 'get' });
    await Promise.all([1, 2, 3].map(() => transfers.click('user', entryId, action))); await drain();
    expect(state().jobs).toHaveLength(1); expect(state().jobs[0].state).toBe('delivered');
    expect(deps.create).toHaveBeenCalledTimes(2); expect(deps.upload).toHaveBeenCalledTimes(1); expect(deps.sendFile).toHaveBeenCalledTimes(1);
    expect((deps.patch as any).mock.calls.every((call: any[]) => call[0] !== entryId)).toBe(true);
    expect(await click()).toBe('File already delivered.'); await drain(); expect(deps.sendFile).toHaveBeenCalledTimes(1);
    expect(JSON.stringify((deps.create as any).mock.calls)).not.toContain(payload.toString());
    expect(deps.inline).not.toHaveBeenCalled();
    const job = state().jobs[0]; expect(job.card.uuid).not.toBe(job.send.uuid);
    // Admit the pending terminal presentation without changing delivery timers.
    if (job.display) job.display.after = 0;
    await (transfers as any).present(job, state().references[0]);
    const delivered = JSON.parse((deps.patch as any).mock.calls.at(-1)[1]);
    expect(delivered.header).toMatchObject({ template: 'green', title: { content: 'File delivered' } });
    expect(JSON.stringify(delivered)).toContain('Find the file message in this chat.');
    expect(delivered.body.elements.some((element: any) => element.tag === 'button')).toBe(false);
  });
  it.each(['known', 'intent'])('keeps historical %s entry content and its UUID immutable after restart', async phase => {
    await entry(); const ref = state().references[0];
    const legacy = JSON.stringify({ schema: '2.0', header: { title: { tag: 'plain_text', content: 'Output file' } },
      body: { elements: [{ tag: 'div', text: { tag: 'plain_text', content: 'Historical entry content' } }] } });
    ref.card.content = legacy; ref.card.state = phase;
    if (phase === 'intent') delete ref.card.id;
    const uuid = ref.card.uuid;
    await durableJson(path.join(root, 'router', 'state.json'), state());
    await transfers.destroy(); transfers = new OutputTransfers(path.join(root, 'router'), deps); await transfers.initialize();
    const restored = state().references[0];
    expect(restored.card.content).toBe(legacy); expect(restored.card.uuid).toBe(uuid);
    expect(restored.card.state).toBe(phase === 'intent' ? 'uncertain' : 'known');
    await transfers.offer('device', restored.reference); await drain();
    expect(deps.create).toHaveBeenCalledOnce(); expect(deps.patch).not.toHaveBeenCalled();
  });
  it('refreshes the final offer cohort after new files arrive during an in-flight parent patch', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const cohorts: number[] = [];
    deps.inline = vi.fn(async () => { cohorts.push(transfers.inlineRows({ messageId: 'reply', openId: 'user', deviceId: 'device', epoch: 'owner-epoch', threadId: 'thread' }).length); if (cohorts.length === 1) await gate; });
    await transfers.admitSource({ messageId: 'reply', deviceId: 'device', openId: 'user', threadId: 'thread', epoch: 'owner-epoch' });
    try {
      await transfers.offer('device', reference());
      expect(cohorts).toEqual([1]);
      for (let i = 1; i < 16; i++) await transfers.offer('device', { ...reference(), id: i.toString(16).padStart(64, '0'), name: `report-${i}.csv` });
      expect(cohorts).toEqual([1]);
      release(); await Promise.allSettled([...(transfers as any).entryWork.values()]);
      expect(cohorts).toEqual([1, 16]); expect(deps.create).not.toHaveBeenCalled();
    } finally { release(); await Promise.allSettled([...(transfers as any).entryWork.values()]); }
  });
  it('joins the full durable reference identity even when its source inventory is missing after restart', async () => {
    const identity = { messageId: 'reply', openId: 'user', deviceId: 'device', epoch: 'owner-epoch', threadId: 'thread', generation: 2 };
    await transfers.admitSource(identity); await transfers.offer('device', reference());
    expect(transfers.inlineRows(identity)).toHaveLength(1);
    state().sources = []; await (transfers as any).save();
    await transfers.destroy(); transfers = new OutputTransfers(path.join(root, 'router'), deps); await transfers.initialize();
    expect(transfers.identityStatus(identity)).toBe('match');
    for (const key of ['openId', 'deviceId', 'epoch', 'threadId', 'generation'] as const) {
      const foreign = { ...identity, [key]: key === 'generation' ? 3 : 'foreign' };
      expect(transfers.inlineRows(foreign)).toEqual([]); expect(transfers.identityStatus(foreign)).toBe('conflict');
      await expect(transfers.admitSource(foreign)).rejects.toThrow('source conflict');
    }
    deps.parentAllowed = vi.fn(async () => false);
    expect(await transfers.click('user', 'foreign-card', { id, op: 'get' })).toContain('unavailable');
    expect(deps.parentAllowed).toHaveBeenCalledWith(identity, 'foreign-card');
    expect(state().references).toHaveLength(1); expect(state().jobs).toEqual([]);
  });
  it('holds conflicting durable generations even when the caller has no generation yet', async () => {
    const identity = { messageId: 'reply', openId: 'user', deviceId: 'device', epoch: 'owner-epoch', threadId: 'thread' };
    await transfers.admitSource(identity); await transfers.offer('device', reference());
    state().sources[0].generation = 3;
    expect(transfers.identityStatus(identity)).toBe('conflict'); expect(transfers.inlineRows(identity)).toEqual([]);
    deps.parentAllowed = vi.fn(async () => true);
    expect(await transfers.click('user', 'parent', { id, op: 'get' })).toContain('unavailable');
    expect(deps.parentAllowed).not.toHaveBeenCalled(); expect(state().jobs).toEqual([]);
  });
  it('does not initialize byte storage to inspect an unknown identity or render disabled hints', async () => {
    const cold = new OutputTransfers(path.join(root, 'cold'), deps);
    const initialize = vi.spyOn(cold, 'initialize'); const read = vi.spyOn(fs, 'readFile'); const list = vi.spyOn(fs, 'readdir');
    const identity = { messageId: 'reply', openId: 'user', deviceId: 'device', epoch: 'epoch', threadId: 'thread' };
    expect(cold.identityStatus(identity)).toBe('unknown'); expect(cold.inlineRows(identity)).toEqual([]);
    expect(initialize).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled(); await cold.destroy();
  });
  it('seals initially unresolved source thread identity and rejects later generation changes', async () => {
    await transfers.admitSource({ messageId: 'reply', openId: 'user', deviceId: 'device', epoch: 'owner-epoch' });
    await transfers.admitSource({ messageId: 'reply', openId: 'user', deviceId: 'device', epoch: 'owner-epoch', threadId: 'thread', generation: 2 });
    await transfers.offer('device', reference());
    expect(state().references[0].threadId).toBe('thread');
    await expect(transfers.admitSource({ messageId: 'reply', openId: 'user', deviceId: 'device', epoch: 'owner-epoch', generation: 3 })).rejects.toThrow('source conflict');
  });
  it('holds new references without a recoverable parent instead of creating standalone cards', async () => {
    await transfers.admitSource({ messageId: 'reply', deviceId: 'device', openId: 'user', threadId: 'thread', epoch: 'owner-epoch' });
    await transfers.offer('device', reference()); await drain();
    expect(state().references[0].card).toBeUndefined(); expect(deps.create).not.toHaveBeenCalled();
    expect(await transfers.click('user', 'guessed-card', { id, op: 'get' })).toContain('unavailable');
  });
  it('delivers despite unknown task-card creation and never resends on failed terminal patches', async () => {
    await entry(); deps.create = vi.fn(async () => { throw new Error('unknown'); });
    await click(); await drain(); expect(state().jobs[0].card.state).toBe('uncertain'); expect(state().jobs[0].state).toBe('delivered');
    expect(deps.sendFile).toHaveBeenCalledTimes(1); await click(); await drain(); expect(deps.create).toHaveBeenCalledTimes(1);
  });
  it('bounds terminal display retries without changing successful delivery', async () => {
    await entry(); deps.patch = vi.fn(async () => { throw new Error('card retracted'); });
    await click(); await drain(); for (let i = 0; i < 10; i++) { await transfers.tick(); await drain(); }
    expect(state().jobs[0].state).toBe('delivered'); expect(deps.sendFile).toHaveBeenCalledTimes(1);
    expect((deps.patch as any).mock.calls.length).toBeLessThanOrEqual(5);
  });
});

describe('receipts, retry and ownership epochs', () => {
  it('keeps unknown native sends terminal across restart and rejects ordinary Retry', async () => {
    await entry(); deps.sendFile = vi.fn(async () => { throw new Error('lost acknowledgement'); });
    await click(); await drain(); const job = state().jobs[0]; expect(job.state).toBe('send-uncertain');
    expect(await transfers.click('user', job.card.id, { id, op: 'retry', rev: job.revision })).toContain('unavailable');
    await transfers.destroy(); transfers = new OutputTransfers(path.join(root, 'router'), deps); await transfers.initialize(); await drain();
    expect(state().jobs[0].state).toBe('send-uncertain'); expect(deps.sendFile).toHaveBeenCalledTimes(1);
  });
  it('retries confirmed rejection on the same job/card and guards stale revisions', async () => {
    await entry(); deps.sendFile = vi.fn().mockRejectedValueOnce(new OutputApiRejection()).mockResolvedValue('file-message');
    await click(); await drain(); const job = state().jobs[0]; expect(job.state).toBe('failed'); const rev = job.revision;
    expect(await transfers.click('user', job.card.id, { id, op: 'retry', rev: rev - 1 })).toContain('unavailable');
    await Promise.all([transfers.click('user', job.card.id, { id, op: 'retry', rev }), transfers.click('user', job.card.id, { id, op: 'retry', rev })]);
    await drain(); expect(job.state).toBe('delivered'); expect(deps.create).toHaveBeenCalledTimes(2);
    expect(deps.upload).toHaveBeenCalledTimes(1); expect(deps.sendFile).toHaveBeenCalledTimes(2);
  });
  it('keeps unknown upload separate and reuses verified spool on safe retry', async () => {
    await entry(); deps.upload = vi.fn().mockRejectedValueOnce(new Error('upload ACK lost')).mockResolvedValue('file-key');
    await click(); await drain(); const job = state().jobs[0]; expect(job.state).toBe('failed'); expect(job.send).toBeUndefined();
    const grants = (deps.send as any).mock.calls.filter((c: any[]) => c[1].type === 'output_grant').length;
    await transfers.click('user', job.card.id, { id, op: 'retry', rev: job.revision }); await drain();
    expect(job.state).toBe('delivered'); expect((deps.send as any).mock.calls.filter((c: any[]) => c[1].type === 'output_grant')).toHaveLength(grants);
  });
  it('queues an offline original device without consuming a slot, then resumes authenticated delivery', async () => {
    await entry(); session = undefined; await click(); await drain();
    expect(state().jobs[0].state).toBe('waiting-device'); expect((transfers as any).running.size).toBe(0);
    session = { id: 'connection-2', openId: 'user' }; await drain(); expect(state().jobs[0].state).toBe('delivered');
  });
  it('rejects stale connection uploads and preserves unrelated sessions', async () => {
    await entry(); deps.send = vi.fn((_device, value: any) => {
      if (value.type !== 'output_grant') return;
      session = { id: 'replacement', openId: 'user' };
      const request = ctx(value.token, payload);
      receiving.push(transfers.receive(request, value.transferId).then(() => {
        expect(request.status).toBe(403); transfers.failed('device', value.transferId);
      }));
    });
    await click(); await drain(); expect(state().jobs[0].state).toBe('failed'); expect(deps.sendFile).not.toHaveBeenCalled();
  });
  it('revokes queued jobs after ownership changes and expires old references', async () => {
    await entry(); session = undefined; await click(); await drain(); owned = false; await drain(); expect(state().jobs[0].state).toBe('revoked');
    expect(deps.sendFile).not.toHaveBeenCalled();
    owned = true; state().references[0].reference.expiresAt = Date.now() - 1;
    state().jobs = []; expect(await click()).toContain('expired');
  });
  it('rejects corrupt and oversized bytes without Feishu upload', async () => {
    await entry(); payload = Buffer.from('wrong bytes'); await click(); await drain();
    expect(state().jobs[0].state).toBe('failed'); expect(deps.upload).not.toHaveBeenCalled();
    const bad = ctx('invalid', payload); await transfers.receive(bad, 'x'); expect(bad.status).toBe(403);
  });
  it('recovers prepared crash states without replaying external message creation', async () => {
    await entry(); session = undefined; await click(); await drain();
    const job = state().jobs[0]; job.state = 'send-intent'; job.card.state = 'intent';
    const content = job.card.content, uuid = job.card.uuid;
    await durableJson(path.join(root, 'router', 'state.json'), state());
    await transfers.destroy(); transfers = new OutputTransfers(path.join(root, 'router'), deps); await transfers.initialize(); await drain();
    expect(state().jobs[0].state).toBe('send-uncertain'); expect(state().jobs[0].card.state).toBe('uncertain'); expect(deps.sendFile).not.toHaveBeenCalled();
    expect(state().jobs[0].card.content).toBe(content); expect(state().jobs[0].card.uuid).toBe(uuid);
  });
  it('fails closed when intent persistence fails before any external effect', async () => {
    await entry(); await fs.rename(path.join(root, 'router'), path.join(root, 'original'));
    await fs.writeFile(path.join(root, 'router'), 'not a directory');
    await expect(click()).rejects.toThrow('storage'); expect(deps.sendFile).not.toHaveBeenCalled();
  });
});

it('ignores legacy count-only discovery without creating cards or new notice receipts', async () => {
  await entry(); const count = (deps.create as any).mock.calls.length;
  await transfers.discovery('device', { messageId: 'reply', taskId: 'task', unavailable: 1, omitted: true });
  expect(deps.create).toHaveBeenCalledTimes(count); expect(state().sources[0].notices).toBeUndefined();
});

it('counts retained failed spools against quota before admitting more bytes', async () => {
  await entry(); session = undefined; await click(); await drain();
  state().jobs.push({ id: 'b'.repeat(64), refId: id, deviceId: 'other', openId: 'other', epoch: 'other', state: 'failed',
    createdAt: Date.now(), updatedAt: Date.now(), revision: 0, received: 0, spoolBytes: OUTPUT_LIMITS.routerBytes,
    card: { state: 'unavailable', uuid: 'other', content: '{}', firstAt: Date.now() } });
  session = { id: 'online', openId: 'user' }; await drain();
  expect(state().jobs[0].state).toBe('failed'); expect(deps.upload).not.toHaveBeenCalled();
});

it('does not create or send cards after ownership is revoked', async () => {
  await entry(); session = undefined; await click(); await drain(); const before = (deps.create as any).mock.calls.length;
  owned = false; await drain();
  expect(state().jobs[0].state).toBe('revoked'); expect(deps.create).toHaveBeenCalledTimes(before); expect(deps.sendFile).not.toHaveBeenCalled();
});

it('ignores a late upload completion after its transfer attempt has failed', async () => {
  await entry(); let entered!: () => void, release!: () => void;
  const beforeRename = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to).endsWith('.bin')) { entered(); await gate; }
    return rename(from, to);
  });
  try {
    await click(); await beforeRename;
    const [transferId] = (transfers as any).grants.keys(); transfers.failed('device', transferId);
    await Promise.allSettled([...(transfers as any).running.values()]);
    expect(state().jobs[0].state).toBe('failed'); release(); await Promise.allSettled(receiving);
    expect(state().jobs[0].state).toBe('failed'); expect(deps.upload).not.toHaveBeenCalled(); expect(deps.sendFile).not.toHaveBeenCalled();
  } finally { release(); await Promise.allSettled(receiving); }
});

it('does not let an offline device block a different original device', async () => {
  await entry(); const second = { ...reference(), id: 'b'.repeat(64), messageId: 'second-reply' };
  await transfers.admitSource({ messageId: second.messageId, deviceId: 'device-2', openId: 'user', threadId: 'thread', epoch: 'owner-epoch' });
  await transfers.offer('device-2', second); await Promise.allSettled([...(transfers as any).entryWork.values()]);
  state().references[1].card = { id: 'legacy-second-card', uuid: 'legacy-second', content: outputFileEntryCard(second), firstAt: Date.now(), state: 'known' };
  await (transfers as any).save();
  deps.session = deviceId => deviceId === 'device-2' ? { id: 'online-second', openId: 'user' } : undefined;
  await click(); await transfers.click('user', state().references[1].card.id, { id: second.id, op: 'get' }); await drain();
  expect(state().jobs.find((j: any) => j.refId === id).state).toBe('waiting-device');
  expect(state().jobs.find((j: any) => j.refId === second.id).state).toBe('delivered');
});

it('bounds unknown task-card creation, ignores its late receipt, and still delivers the file', async () => {
  await entry();
  let entered!: () => void, complete!: (id: string) => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const late = new Promise<string>(resolve => { complete = resolve; });
  deps.create = vi.fn(() => { entered(); return late; });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    await click(); await started; await vi.advanceTimersByTimeAsync(8000); await drain();
    const job = state().jobs[0]; expect(job.state).toBe('delivered'); expect(job.card.state).toBe('uncertain');
    complete('late-card'); await Promise.resolve(); expect(job.card.id).toBeUndefined();
    expect(deps.sendFile).toHaveBeenCalledTimes(1);
  } finally { complete('late-card'); vi.useRealTimers(); }
});

it('streams snapshots with HTTP backpressure while independent WebSocket heartbeats remain responsive', async () => {
  payload = Buffer.alloc(2 * 1024 * 1024, 65);
  const home = path.join(root, 'home'); await fs.mkdir(home); vi.spyOn(os, 'homedir').mockReturnValue(home);
  const cwd = path.join(root, 'workspace'); await fs.mkdir(cwd); await fs.writeFile(path.join(cwd, 'report.csv'), payload);
  const snapshots = new OutputSnapshots(path.join(root, 'cli')); await snapshots.initialize();
  const ref = await snapshots.snapshot('report.csv', { messageId: 'reply', threadId: 'thread', taskId: 'task', generation: 0, cwd, source: 'workspace' });
  let entered!: () => void, release!: () => void;
  const receivingStarted = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const app = new Koa(); app.use(async context => {
    context.req.pause(); entered(); await gate; await transfers.receive(context, context.path.split('/').pop()!);
  });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const sockets = new WebSocketServer({ server }); sockets.on('connection', socket => socket.on('message', data => socket.send(data)));
  const control = new WebSocket(`ws://127.0.0.1:${(server.address() as any).port}`); await once(control, 'open');
  const client = new OutputFiles(snapshots, `ws://127.0.0.1:${(server.address() as any).port}`, message => {
    const value = message as any;
    if (value.type === 'output_offer') receiving.push(transfers.offer('device', value.reference));
    if (value.type === 'output_transfer_failed') transfers.failed('device', value.transferId);
  });
  deps.send = (_device, message) => client.handle(message);
  try {
    await entry(ref); client.connect(); await Promise.allSettled(receiving);
    await transfers.click('user', state().references[0].card.id, { id: ref.id, op: 'get' });
    await receivingStarted; const heartbeat = once(control, 'message'); control.send('heartbeat');
    expect((await heartbeat)[0].toString()).toBe('heartbeat'); release(); await drain();
    expect(state().jobs[0].state).toBe('delivered'); expect(deps.upload).toHaveBeenCalledTimes(1); expect(deps.sendFile).toHaveBeenCalledTimes(1);
  } finally { release(); await client.destroy(); control.terminate(); await new Promise<void>(resolve => sockets.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve())); }
});


it('does not acknowledge or publish an offer after source persistence fails even if admission is caught', async () => {
  await fs.rename(path.join(root, 'router'), path.join(root, 'original'));
  await fs.writeFile(path.join(root, 'router'), 'not a directory');
  await transfers.admitSource({ messageId: 'reply', deviceId: 'device', openId: 'user', threadId: 'thread', epoch: 'owner-epoch' }).catch(() => {});
  await expect(transfers.offer('device', reference())).rejects.toThrow('storage');
  expect(state().references).toHaveLength(0);
  expect(deps.send).not.toHaveBeenCalled();
  expect(deps.create).not.toHaveBeenCalled();
});

it('preserves a terminal display update while an older progress patch is pending', async () => {
  await entry(); session = undefined; await click(); await drain();
  const job = state().jobs[0], ref = state().references[0];
  await (transfers as any).change(job, 'receiving');
  job.display = undefined;
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  deps.patch = vi.fn(() => { entered(); return new Promise<void>(resolve => { release = resolve; }); });
  const progress = (transfers as any).present(job, ref);
  await started;
  try {
    await (transfers as any).change(job, 'delivered');
    release(); await progress;
    expect(job.displayPending).toBe(true);
    deps.patch = vi.fn(async () => {}); job.display.after = 0;
    await (transfers as any).present(job, ref);
    expect(deps.patch).toHaveBeenCalledOnce();
    expect((deps.patch as any).mock.calls[0][1]).toContain('File delivered');
    expect(job.displayPending).toBe(false);
  } finally { release(); await progress; }
});
