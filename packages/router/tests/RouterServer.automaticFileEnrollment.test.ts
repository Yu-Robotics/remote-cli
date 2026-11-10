import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { once } from 'events';
import { OutputFiles } from '../../cli/src/output/OutputFiles';
import { OutputSnapshots } from '../../cli/src/output/OutputSnapshots';
import { OutputLinks } from '../../cli/src/output/OutputLinks';
import { PendingOutputFiles } from '../../cli/src/output/PendingOutputFiles';
import { RouterServer } from '../src/server';
import { JsonStore } from '../src/storage/JsonStore';
import { FeishuLongConnHandler } from '../src/feishu/FeishuLongConnHandler';
import { WebSocketClient } from '../../cli/src/client/WebSocketClient';
import { AutomaticFileEnrollment } from '../../cli/src/files/AutomaticFileEnrollment';
import { ensureIdentity, loadIdentity } from '../../cli/src/files/DeviceIdentity';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('automatic file enrollment over the existing connection', () => {
  let root: string;
  let server: RouterServer;
  let url: string;
  let client: WebSocketClient | undefined;
  let create: ReturnType<typeof vi.spyOn>;
  let messages: any[];
  let listeners: Array<() => void>;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'auto-enrollment-wire-')));
    messages = []; listeners = [];
    vi.spyOn(os, 'homedir').mockReturnValue(root);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(FeishuLongConnHandler.prototype, 'start').mockResolvedValue(undefined);
    vi.spyOn(FeishuLongConnHandler.prototype, 'stop').mockResolvedValue(undefined);
    create = vi.spyOn(FeishuLongConnHandler.prototype, 'createOutputCard').mockResolvedValue('approval-card');
  });
  afterEach(async () => {
    client?.disconnect();
    await server?.stop();
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function start(enabled = true, bound = true) {
    const config: any = { getConfigPath: () => path.join(root, 'router', 'config.json'),
      get: (section: string, key?: string) => {
        if (section === 'server') return key === 'port' ? 0 : key === 'host' ? '127.0.0.1' : 'fixture';
        if (section === 'websocket') return 30_000;
        if (section === 'files') return { enabled };
        if (section === 'tips') return { enabled: false };
        return 'fixture';
      } };
    const store = new JsonStore(path.join(root, 'bindings.json'), 0); await store.initialize();
    server = new RouterServer(config, store);
    if (bound) await (server as any).bindingManager.bindUser('owner', 'device', 'Synthetic device');
    await server.start();
    const http = (server as any).httpServer;
    if (!http.listening) await once(http, 'listening');
    url = `ws://127.0.0.1:${http.address().port}/ws`;
  }

  function waitFor(predicate: (message: any) => boolean): Promise<any> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const value = messages.find(predicate);
        if (value) { clearTimeout(timer); listeners = listeners.filter(item => item !== check); resolve(value); }
      };
      const timer = setTimeout(() => { listeners = listeners.filter(item => item !== check); reject(new Error('Expected protocol phase was not reached.')); }, 10_000);
      listeners.push(check); check();
    });
  }

  async function connect(autoEnroll = true) {
    client = new WebSocketClient(url, 'device', {
      identityLoader: () => loadIdentity(root, url, 'device'),
      automaticFileEnrollment: new AutomaticFileEnrollment(root, url, 'device', autoEnroll),
      reconnectInterval: 20,
    });
    client.onMessage(message => { messages.push(message); for (const notify of [...listeners]) notify(); });
    await client.connect();
    return waitFor(message => message.type === 'binding_confirm');
  }

  function pauseAdmission() {
    const service = (server as any).automaticFileEnrollment;
    const original = service.request.bind(service);
    const entered = deferred<any[]>();
    const gate = deferred<void>();
    const completed = deferred<string>();
    vi.spyOn(service, 'request').mockImplementationOnce(async (...args: any[]) => {
      entered.resolve(args); await gate.promise;
      const result = await original(...args); completed.resolve(result); return result;
    });
    return { entered, gate, completed };
  }

  it.each(['owner', 'replacement-owner'])('never retargets a registered connection request after rebinding to %s', async replacement => {
    await start(); await connect(false);
    const bindings = (server as any).bindingManager;
    const epoch = bindings.getCardThreadEpoch('owner', 'device');
    const key = await ensureIdentity(root, url, 'device');
    const paused = pauseAdmission();
    client!.send({ type: 'automatic_file_enrollment', data: AutomaticFileEnrollment.proof(key, 'device') });
    try {
      const args = await paused.entered.promise;
      expect(args[2]).toEqual({ openId: 'owner', epoch });
      expect(Object.isFrozen(args[2])).toBe(true);
      expect(args[3]()).toBe(true);
      await bindings.unbindDevice('owner', 'device');
      await bindings.bindUser(replacement, 'device', 'Synthetic replacement device');
    } finally { paused.gate.resolve(); await paused.completed.promise; }
    expect(await paused.completed.promise).toBe('unbound');
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects admission from a disconnected socket even after a replacement connection is registered', async () => {
    await start(); await connect(false);
    const key = await ensureIdentity(root, url, 'device');
    const paused = pauseAdmission();
    client!.send({ type: 'automatic_file_enrollment', data: AutomaticFileEnrollment.proof(key, 'device') });
    try {
      const args = await paused.entered.promise;
      const socket = (server as any).connectionHub.connections.get('device');
      const closed = once(socket, 'close'); client!.disconnect(); await closed;
      messages = []; await connect(false);
      expect(args[3]()).toBe(false);
    } finally { paused.gate.resolve(); await paused.completed.promise; }
    expect(await paused.completed.promise).toBe('unbound');
    expect(create).not.toHaveBeenCalled();
  });

  it('finishes a same-owner pending notification after a valid admission loses its socket', async () => {
    await start(); await connect(false);
    const key = await ensureIdentity(root, url, 'device');
    const auth = (server as any).deviceAuth;
    const get = auth.get.bind(auth);
    const entered = deferred<void>(); const gate = deferred<void>(); const completed = deferred<string>();
    vi.spyOn(auth, 'get').mockImplementationOnce(async (...args: any[]) => {
      const snapshot = await get(...args); entered.resolve(); await gate.promise; return snapshot;
    });
    const service = (server as any).automaticFileEnrollment;
    const request = service.request.bind(service);
    vi.spyOn(service, 'request').mockImplementationOnce(async (...args: any[]) => {
      const result = await request(...args); completed.resolve(result); return result;
    });
    client!.send({ type: 'automatic_file_enrollment', data: AutomaticFileEnrollment.proof(key, 'device') });
    try {
      await entered.promise;
      const socket = (server as any).connectionHub.connections.get('device');
      const closed = once(socket, 'close'); client!.disconnect(); await closed;
    } finally { gate.resolve(); await completed.promise; }
    expect(await completed.promise).toBe('known');
    expect(create).toHaveBeenCalledWith('owner', expect.any(String), expect.any(String));
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('requests once, leaves text dispatch working, approves the exact owner/card, and reconnects signed without another prompt', async () => {
    await start();
    expect((await connect()).data.capabilities.automaticFileEnrollmentV1).toBe(true);
    await waitFor(message => message.type === 'automatic_file_enrollment_status');
    expect(create).toHaveBeenCalledTimes(1);
    const saved = (await loadIdentity(root, url, 'device'))!;
    expect(saved).toBeDefined();
    const handler = (server as any).feishuLongConnHandler as FeishuLongConnHandler;
    const value = JSON.parse(create.mock.calls[0][1]).body.elements.at(-1).behaviors[0].value;
    const callback = (owner: string, card = 'approval-card') => handler.handleCardAction({ operator: { open_id: owner },
      context: { open_message_id: card }, action: { value } });
    await callback('intruder'); await callback('owner', 'wrong-card');
    expect(await (server as any).deviceAuth.get('device')).toBeUndefined();
    // No model task is started by enrollment; ordinary messages continue on the same connection.
    await (server as any).connectionHub.sendToDevice('device', { type: 'command', messageId: 'text-phase', content: 'Synthetic text task' });
    await waitFor(message => message.messageId === 'text-phase');
    expect((await callback('owner'))?.toast.content).toContain('approved');
    const authenticated = await waitFor(message => message.type === 'binding_confirm' && message.data.capabilities?.fileTransferV1);
    expect(authenticated.data.capabilities.automaticFileEnrollmentV1).toBeUndefined();
    expect(authenticated.data.capabilities.outputFilesV1).toBe(true);
    expect((await (server as any).deviceAuth.get('device')).publicKey).toBe(saved.publicKey);
    expect(create).toHaveBeenCalledTimes(1);
    client!.disconnect(); messages = [];
    expect((await connect()).data.capabilities.fileTransferV1).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('dispatches the single Get file through approval and the original card despite a presentation failure: %s', async failPresentation => {
    const patches: any[] = [];
    let failNextPatch = false;
    vi.spyOn(FeishuLongConnHandler.prototype, 'patchInlineOutputCard').mockImplementation(async (_id, content) => {
      if (failNextPatch) { failNextPatch = false; throw new Error('Synthetic presentation failure'); }
      patches.push(JSON.parse(content));
    });
    await start(); await connect(); await waitFor(m => m.type === 'automatic_file_enrollment_status');
    const originalApproval = JSON.parse(create.mock.calls[0][1]).body.elements.at(-1).behaviors[0].value;
    const internal = server as any, inline = internal.inlineFileCards;
    const owner = { messageId: 'original-reply', rootId: 'original-card', openId: 'owner', deviceId: 'device',
      threadId: 'original-thread', generation: 3, epoch: internal.selections.capture('owner', 'device').epoch };
    await inline.admit(owner); inline.remember('original-card', owner.rootId, JSON.stringify({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'Original answer' }] } }));
    await inline.bind(owner.rootId, 'original-card');
    await inline.hints('device', { messageId: owner.messageId, threadId: owner.threadId, generation: 3, names: ['report.csv'] }, 'approval');
    const panel = () => patches.at(-1).body.elements.find((e: any) => e.element_id === 'output_files_inline');
    const buttons = panel().elements.filter((e: any) => e.tag === 'button');
    expect(buttons).toHaveLength(1); expect(buttons[0]).toMatchObject({ disabled: false, type: 'default', text: { content: 'Get file' } });
    const get = buttons[0].behaviors[0].value;
    const handler = internal.feishuLongConnHandler as FeishuLongConnHandler;
    const callback = (value: any, openId = 'owner', cardId = 'original-card') => handler.handleCardAction({ operator: { open_id: openId },
      context: { open_message_id: cardId }, action: { value } });
    await callback(get, 'intruder'); await callback(get, 'owner', 'foreign-card'); await callback({ ...get, generation: 4 });
    expect(create).toHaveBeenCalledTimes(1);
    await Promise.all([callback(get), callback(get)]); expect(create).toHaveBeenCalledTimes(2);
    expect(await internal.deviceAuth.get('device')).toBeUndefined();
    expect(internal.outputTransfers.inlineRows(owner)).toEqual([]);
    const cwd = path.join(root, 'workspace'); await fs.mkdir(cwd); await fs.writeFile(path.join(cwd, 'report.csv'), 'bytes when approved');
    const pending = new PendingOutputFiles(); const links = new OutputLinks(); links.append('[Report](report.csv "attachment")');
    pending.remember(links, { owner: 'owner', messageId: owner.messageId, threadId: owner.threadId, generation: 3,
      cwd, taskId: owner.messageId, source: 'workspace' }, () => true);
    let files: OutputFiles | undefined;
    const work: Promise<unknown>[] = [];
    client!.onMessage(message => {
      if (message.type === 'binding_confirm' && message.data.capabilities?.outputFilesV1) {
        const task = (async () => {
          expect(message.data.capabilities.pendingOutputFilesV1).toBe(true);
          files = new OutputFiles(new OutputSnapshots(path.join(root, 'snapshots')), url, m => client!.send(m));
          await files.initialize(); files.connect(); client!.send({ type: 'pending_outputs_ready' });
        })(); work.push(task);
      }
      if (message.type === 'prepare_pending_output') work.push(pending.prepare(message, files));
    });
    try {
      const renewed = JSON.parse(create.mock.calls[1][1]).body.elements.at(-1).behaviors[0].value;
      expect((await callback(originalApproval, 'owner', 'approval-card'))?.toast.content).toContain('unavailable');
      failNextPatch = failPresentation;
      expect((await callback(renewed, 'owner', 'approval-card'))?.toast.content).toContain('approved');
      await waitFor(m => m.type === 'output_registered');
      await vi.waitFor(() => expect(panel().elements.some((e: any) => e.behaviors?.[0]?.value.action === 'output_file')).toBe(true));
      const migrated = inline.ownerFor(owner.messageId);
      expect(migrated).toMatchObject({ messageId: owner.messageId, deviceId: 'device', threadId: 'original-thread', generation: 3 });
      expect(migrated.epoch).not.toBe(owner.epoch);
      expect(await inline.allows(migrated, 'original-card')).toBe(true);
      expect(await inline.allows(owner, 'original-card')).toBe(false);
      const refs = files!.snapshots.references(); expect(refs).toHaveLength(1);
      expect(refs[0]).toMatchObject({ messageId: owner.messageId, threadId: 'original-thread', generation: 3, name: 'report.csv' });
      const ready = panel().elements.find((e: any) => e.behaviors?.[0]?.value.action === 'output_file');
      expect(ready).toMatchObject({ type: 'primary', disabled: false, text: { content: 'Get file' } });
      const retrieve = vi.spyOn(internal.outputTransfers, 'click').mockResolvedValue('File retrieval queued.');
      await callback(ready.behaviors[0].value);
      expect(retrieve).toHaveBeenCalledWith('owner', 'original-card', ready.behaviors[0].value);
      expect(create).toHaveBeenCalledTimes(2);
    } finally { await Promise.allSettled(work); await files?.destroy(); }
  });

  it('retains preparation across session replacement while refreshing the original card', async () => {
    await start();
    const internal = server as any;
    const owner = { messageId: 'original-reply', rootId: 'original-card', openId: 'owner', deviceId: 'device',
      threadId: 'original-thread', generation: 3, epoch: internal.selections.capture('owner', 'device').epoch };
    internal.preparedOutputParents.set(owner.messageId, owner);
    internal.pendingOutputDevices.add('device');
    internal.outputSessions.set('device', { id: 'old-session', openId: 'owner' });
    internal.readyOutputSessions.set('device', 'old-session');
    const entered = deferred<void>(), release = deferred<void>();
    vi.spyOn(internal.inlineFileCards, 'refresh').mockImplementationOnce(async () => {
      entered.resolve(); await release.promise;
    }).mockResolvedValue(undefined);
    const send = vi.spyOn(internal.connectionHub, 'sendToDevice').mockResolvedValue(true);
    const first = internal.drainPendingOutputs('device');
    await entered.promise;
    internal.outputSessions.set('device', { id: 'new-session', openId: 'owner' });
    internal.readyOutputSessions.delete('device');
    release.resolve(); await first;
    expect(send).not.toHaveBeenCalled();
    expect(internal.preparedOutputParents.get(owner.messageId)).toEqual(owner);
    internal.readyOutputSessions.set('device', 'new-session');
    await internal.drainPendingOutputs('device');
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith('device', { type: 'prepare_pending_output', messageId: owner.messageId,
      openId: owner.openId, threadId: owner.threadId, generation: 3 });
    expect(internal.preparedOutputParents.has(owner.messageId)).toBe(false);
  });

  it.each([true, false])('never prompts an already manually approved device with auto enrollment %s', async autoEnroll => {
    await start();
    const saved = await ensureIdentity(root, url, 'device');
    await (server as any).deviceAuth.enroll('device', 'owner', saved.publicKey);
    const confirmation = await connect(autoEnroll);
    expect(confirmation.data.capabilities.fileTransferV1).toBe(true);
    expect(confirmation.data.capabilities.automaticFileEnrollmentV1).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
  });

  it.each(['disabled', 'opt-out', 'unbound'])('keeps legacy text operation without approval prompts when %s', async mode => {
    await start(mode !== 'disabled', mode !== 'unbound');
    const confirmation = await connect(mode !== 'opt-out');
    if (mode !== 'opt-out') expect(confirmation.data.capabilities?.automaticFileEnrollmentV1).toBeUndefined();
    // A server round trip establishes that preceding capability handling has completed.
    client!.send({ type: 'heartbeat', messageId: 'barrier', timestamp: Date.now() });
    await waitFor(message => message.type === 'heartbeat' && message.messageId === 'barrier');
    expect(create).not.toHaveBeenCalled();
    expect(await loadIdentity(root, url, 'device')).toBeUndefined();
  });
});
