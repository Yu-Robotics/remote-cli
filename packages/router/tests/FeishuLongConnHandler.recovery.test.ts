import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import * as lark from '@larksuiteoapi/node-sdk';
import { BindingManager } from '../src/binding/BindingManager';
import { ThreadSelectionManager } from '../src/binding/ThreadSelectionManager';
import { ApprovalCards } from '../src/feishu/ApprovalCards';
import { FeishuLongConnHandler } from '../src/feishu/FeishuLongConnHandler';
import { JsonStore } from '../src/storage/JsonStore';
import { ConnectionHub } from '../src/websocket/ConnectionHub';
import type { ApprovalRequestMessage } from '../src/types';

vi.mock('@larksuiteoapi/node-sdk');

let root: string;
beforeAll(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-card-recovery-'))); });
afterAll(async () => { await fs.rm(root, { recursive: true, force: true }); });

function button(content: string, label: string) {
  const elements = JSON.parse(content).body.elements;
  const buttons = elements.flatMap((row: any) => row.columns?.flatMap((column: any) => column.elements) ?? []);
  const selected = buttons.find((item: any) => item.text?.content === label);
  expect(selected, label).toBeDefined();
  return selected.behaviors[0].value;
}

async function fixture() {
  const directory = await fs.mkdtemp(path.join(root, 'case-'));
  const store = new JsonStore(path.join(directory, 'bindings.json'), 0);
  await store.initialize();
  const bindings = new BindingManager(store);
  await bindings.bindUser('owner', 'original', 'Original');
  await bindings.bindUser('owner', 'second', 'Second');
  const selections = new ThreadSelectionManager(bindings, { names: () => undefined });
  expect(await selections.select('owner', 'original', 'first-thread')).toBe('selected');

  let serial = 0;
  const sdk = {
    create: vi.fn(async (_request: any) => ({ code: 0, data: { message_id: 'card-' + ++serial } })),
    patch: vi.fn(async (_request: any) => ({ code: 0 })),
    reply: vi.fn(async (_request: any) => ({ code: 0 })),
  };
  vi.mocked(lark.Client).mockImplementationOnce(() => ({ im: { message: sdk } }) as unknown as lark.Client);
  const handler = new FeishuLongConnHandler({ appId: 'fixture', appSecret: 'fixture', store });
  const hub = new ConnectionHub();
  vi.spyOn(hub, 'isDeviceOnline').mockReturnValue(true);
  vi.spyOn(hub, 'supportsQueueStarted').mockReturnValue(true);
  const send = vi.spyOn(hub, 'sendToDevice').mockResolvedValue(true);
  handler.setConnectionHub(hub);
  handler.setOnCaptureSelection((user, device) => selections.capture(user, device));
  handler.setOnValidateSelection(fence => selections.isCurrent(fence));
  handler.setOnResolveActiveThread((user, device) => selections.resolve(user, device));
  handler.onDeviceSwitchIntent = (user, device) => { selections.beginIntent(user, device); };
  handler.onQueueAction = (...args) => handler.sendQueueActionFromCardAction(...args);
  const register = async (cardId: string, threadId: string, deviceId: string, queueId?: string) =>
    store.setCardThread(cardId, { threadId, deviceId, openId: 'owner', epoch: bindings.getCardThreadEpoch('owner', deviceId),
      expiresAt: Date.now() + 60_000, ...(queueId ? { queueId } : {}) });
  handler.setOnResolveThread(async (id, user) => {
    const route = store.getCardThread(id);
    if (route?.openId === user) return { threadId: route.threadId, deviceId: route.deviceId };
  });
  handler.setOnStartStreaming(async (_task, _user, cardId, device, thread) => {
    if (cardId && thread) await register(cardId, thread, device);
  });
  const text = (content: string, parent_id?: string) => handler['handleMessageEvent']({
    sender: { sender_id: { open_id: 'owner' } },
    message: { message_type: 'text', message_id: 'text-' + ++serial, content: JSON.stringify({ text: content }), parent_id },
  });
  const click = (card: string, value: object) => handler.handleCardAction({
    operator: { open_id: 'owner' }, context: { open_message_id: card }, action: { value },
  });
  const switchDevice = async () => {
    await text('/device 2');
    expect((await bindings.getActiveDevice('owner'))?.deviceId).toBe('second');
  };
  const queueCard = async (id: string) => {
    const cardId = 'queue-card-' + id;
    const info = { id, threadId: 'first-thread', threadName: 'First', backend: 'codex', cwd: directory,
      preview: 'Review draft', pendingCount: 0, expiresAt: Date.now() + 60_000 };
    expect(await handler.finalizeStreamingMessage(cardId, [], undefined, 'owner', directory, 'First', undefined,
      info.threadId, info, undefined, true, { onDelivered: async (ids, queueCard) => {
        for (const card of ids) await register(card, info.threadId, 'original', card === queueCard ? id : undefined);
      } })).toBe(true);
    expect(store.getCardThread(cardId)).toMatchObject({ threadId: info.threadId, deviceId: 'original' });
    const confirm = button(sdk.patch.mock.lastCall![0].data.content, 'Add to queue');
    return () => click(cardId, confirm);
  };
  return { store, handler, hub, sdk, send, text, click, switchDevice, queueCard, register, directory };
}

function approvalFlow(f: Awaited<ReturnType<typeof fixture>>, taskMessageId: string) {
  const cards = new ApprovalCards({
    ownsDevice: async (user, device) => f.store.getUserByDeviceId(device) === user,
    sendToDevice: (device, frame) => f.hub.sendToDevice(device, frame),
    create: (...args) => f.handler.sendTaskNotificationCard(...args),
    update: (...args) => f.handler.updateApprovalCard(...args),
    registerReplyRoute: f.register,
  });
  f.handler.onApprovalAction = (user, id, card, decision) =>
    cards.click(user, id, card, decision as 'approve' | 'deny' | 'remember');
  const request: ApprovalRequestMessage = { type: 'approval_request', messageId: 'allow-1', taskMessageId, timestamp: 1,
    openId: 'owner', cwd: f.directory, threadId: 'first-thread', threadName: 'First',
    approval: { requestId: 'allow-1', kind: 'command', description: 'Inspect draft', canRemember: false } };
  return { cards, request };
}

describe('Feishu recovery after a device switch', () => {
  it('reports a delayed menu failure on its original card while new chat follows the device switch', async () => {
    const f = await fixture();
    await f.text('/skills');
    const menu = (await f.sdk.create.mock.results.at(-1)!.value).data.message_id;
    const shortcut = button(f.sdk.create.mock.lastCall![0].data.content, 'Model /model');
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const registering = new Promise<void>(resolve => { entered = resolve; });
    f.handler.setOnStartStreaming(async () => { entered(); await hold; });
    const click = f.click(menu, shortcut);
    await registering;
    expect(await click).toMatchObject({ toast: { content: 'Processing your selection.' } });
    await f.switchDevice();
    release();
    await vi.waitFor(() => expect(f.sdk.reply).toHaveBeenCalledWith(expect.objectContaining({
      path: { message_id: menu }, data: expect.objectContaining({ content: expect.stringContaining('Reopen /skills') }),
    })));
    expect(f.send).not.toHaveBeenCalled();
    await f.text('Continue reviewing');
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.send).toHaveBeenCalledWith('second', expect.objectContaining({ content: 'Continue reviewing' }));
  });

  it('reopens an invalidated /skills menu by text and can repeat the command after a send failure', async () => {
    const f = await fixture();
    await f.text('/skills');
    const first = f.sdk.create.mock.lastCall![0];
    const menuId = (await f.sdk.create.mock.results.at(-1)!.value).data.message_id;
    const shortcut = button(first.data.content, 'Model /model');
    await f.switchDevice();
    expect(await f.click(menuId, shortcut)).toMatchObject({ toast: { type: 'error', content: expect.stringContaining('/skills') } });
    expect(f.send).not.toHaveBeenCalled();
    await f.text('/skills');
    const freshId = (await f.sdk.create.mock.results.at(-1)!.value).data.message_id;
    const freshShortcut = button(f.sdk.create.mock.lastCall![0].data.content, 'Model /model');
    f.send.mockRejectedValueOnce(new Error('Synthetic transport failure'));
    expect(await f.click(freshId, freshShortcut)).toMatchObject({ toast: { type: 'error', content: expect.stringMatching(/try again/i) } });
    const retry = button(f.sdk.patch.mock.lastCall![0].data.content, 'Model /model');
    expect(await f.click(freshId, retry)).toMatchObject({ toast: { type: 'info' } });
    await f.text('Continue reviewing');
    expect(f.send.mock.calls.map(([device, frame]) => [device, frame.threadId, frame.content])).toEqual([
      ['second', undefined, '/model'], ['second', undefined, '/model'], ['second', undefined, 'Continue reviewing'],
    ]);
  });

  it('recovers an undelivered approval by text after its task-card route expires on switch', async () => {
    const f = await fixture();
    await f.text('Review draft');
    const taskId = f.send.mock.lastCall![1].messageId;
    const taskCard = (await f.sdk.create.mock.results.at(-1)!.value).data.message_id;
    expect(f.store.getCardThread(taskCard)).toMatchObject({ deviceId: 'original', threadId: 'first-thread' });
    const { cards, request } = approvalFlow(f, taskId);
    try {
      f.sdk.create.mockRejectedValueOnce(new Error('Synthetic card delivery failure'));
      await cards.receive(request, 'original', () => true);
      expect(f.send).toHaveBeenLastCalledWith('original', expect.objectContaining({ type: 'approval_unavailable', messageId: 'allow-1' }));
      await f.switchDevice();
      const before = f.send.mock.calls.length;
      await f.text('no allow-1', taskCard);
      expect(f.send).toHaveBeenCalledTimes(before);
      expect(f.sdk.reply.mock.lastCall![0].data.content).toMatch(/thread link has expired.*resend/i);
      await f.text('/device 1');
      await f.text('no allow-1');
      expect(f.send).toHaveBeenLastCalledWith('original', expect.objectContaining({ type: 'command', threadId: 'first-thread', content: 'no allow-1' }));
      await f.text('Continue here');
      expect(f.send).toHaveBeenLastCalledWith('original', expect.objectContaining({ threadId: 'first-thread', content: 'Continue here' }));
    } finally { cards.destroy(); }
  });

  it('retries a failed approval click on the original device and keeps chat usable after the CLI decision', async () => {
    const f = await fixture();
    const { cards, request } = approvalFlow(f, 'task-1');
    try {
      await cards.receive(request, 'original', () => true);
      const deny = button(f.sdk.create.mock.lastCall![0].data.content, 'Deny');
      const cardId = (await f.sdk.create.mock.results.at(-1)!.value).data.message_id;
      await f.switchDevice();
      f.send.mockRejectedValueOnce(new Error('Synthetic disconnect'));
      expect(await f.click(cardId, deny)).toMatchObject({ toast: { type: 'error', content: expect.stringMatching(/reconnect/i) } });
      expect(f.sdk.patch).not.toHaveBeenCalled();
      const clicks = await Promise.all([f.click(cardId, deny), f.click(cardId, deny)]);
      for (const result of clicks) expect(result).toMatchObject({ toast: { content: expect.stringMatching(/waiting for CLI confirmation/i) } });
      expect(f.send.mock.calls).toEqual(Array(2).fill(['original', expect.objectContaining({
        type: 'approval_response', messageId: request.messageId, taskMessageId: 'task-1', threadId: 'first-thread', action: 'deny',
      })]));
      await vi.waitFor(() => expect(f.sdk.patch.mock.lastCall?.[0].data.content).toContain('Waiting for CLI confirmation'));
      await cards.resolve({ type: 'approval_resolved', messageId: request.messageId, openId: 'owner',
        threadId: 'first-thread', status: 'denied', timestamp: Date.now() }, 'original');
      expect(JSON.parse(f.sdk.patch.mock.lastCall![0].data.content).header.title.content).toContain('Denied');
      expect(await f.click(cardId, deny)).toMatchObject({ toast: { type: 'error' } });
      expect(f.send).toHaveBeenCalledTimes(2);
      await f.text('Continue here');
      expect(f.send).toHaveBeenLastCalledWith('second', expect.objectContaining({ content: 'Continue here' }));
    } finally { cards.destroy(); }
  });
});

describe('queue card after switching devices', () => {
  it('binds a split confirmation to the delivered button page and preserves that association on reload', async () => {
    const f = await fixture();
    const info = { id: 'split', threadId: 'first-thread', threadName: 'First', backend: 'codex', cwd: f.directory,
      preview: 'Review draft', pendingCount: 0, expiresAt: Date.now() + 60_000 };
    const rows = Array.from({ length: 250 }, (_, i) => ({ tag: 'markdown', content: 'Row ' + i }));
    expect(await f.handler.finalizeStreamingMessage('root-card', rows, undefined, 'owner', undefined, 'First',
      undefined, info.threadId, info, undefined, false, { onDelivered: async (ids, queueCard) => {
        for (const card of ids) await f.register(card, info.threadId, 'original', card === queueCard ? info.id : undefined);
      } })).toBe(true);
    const page = f.sdk.create.mock.calls.findIndex(([request]) => request.data.content.includes('queue_confirm'));
    expect(page).toBeGreaterThanOrEqual(0);
    const card = (await f.sdk.create.mock.results[page].value).data.message_id;
    const store = new JsonStore(path.join(f.directory, 'bindings.json'), 0);
    await store.initialize();
    expect(store.getCardThread('root-card')).toMatchObject({ threadId: info.threadId });
    expect(store.getCardThread('root-card')?.queueId).toBeUndefined();
    expect(store.getCardThread(card)?.queueId).toBe(info.id);
    const confirm = button(f.sdk.create.mock.calls[page][0].data.content, 'Add to queue');
    expect(await f.click('root-card', confirm)).toMatchObject({ toast: { type: 'error' } });
    expect(await f.click(card, confirm)).toMatchObject({ toast: { content: 'Queue confirmation sent' } });
    expect(f.send).toHaveBeenCalledOnce();
  });

  it('refuses copied or altered controls and a previous binding of the same device', async () => {
    const f = await fixture();
    const confirm = await f.queueCard('one');
    await f.queueCard('two');
    const cancel = { action: 'queue_cancel', queueId: 'one', threadId: 'first-thread' };
    for (const click of [
      () => f.click('queue-card-two', cancel),
      () => f.click('queue-card-one', { ...cancel, threadId: 'another-thread' }),
      () => f.handler.handleCardAction({ operator: { open_id: 'another-user' }, context: { open_message_id: 'queue-card-one' },
        action: { value: cancel } }),
    ]) expect(await click()).toMatchObject({ toast: { type: 'error' } });
    expect(await f.click('queue-card-one', cancel)).toMatchObject({ toast: { content: 'Queue cancellation sent' } });
    expect(f.sdk.patch.mock.lastCall![0].data.content).not.toMatch(/>Cancelled<|was not added/i);
    const bindings = new BindingManager(f.store);
    await bindings.unbindDevice('owner', 'original');
    await bindings.bindUser('owner', 'original', 'Original');
    await bindings.switchActiveDevice('owner', 'original');
    expect(await confirm()).toMatchObject({ toast: { type: 'error' } });
    expect(f.send.mock.calls).toEqual([['original', expect.objectContaining({ content: '/queue cancel one' })]]);
    await f.text('Continue on original');
    expect(f.send).toHaveBeenLastCalledWith('original', expect.objectContaining({ content: 'Continue on original' }));
  });

  let destinations: string[];
  beforeAll(async () => {
    const f = await fixture();
    const confirm = await f.queueCard('switch');
    await f.switchDevice();
    const response = await confirm();
    destinations = f.send.mock.calls.map(([device]) => device);
    if (destinations.length === 0) expect(response).toMatchObject({ toast: { type: 'error' } });
    else expect(f.send.mock.calls.map(([, frame]) => frame)).toEqual([expect.objectContaining({
      content: expect.stringMatching(/^\/queue confirm switch /), threadId: 'first-thread',
    })]);
    await f.text('Continue on this device');
    expect(f.send).toHaveBeenLastCalledWith('second', expect.objectContaining({ content: 'Continue on this device' }));
  });
  it('never sends the original queue control to the newly active device', () => {
    expect(destinations).not.toContain('second');
  });
});

describe('queue recovery after a binding lookup throws', () => {
  let retries: unknown[];
  beforeAll(async () => {
    const f = await fixture();
    const confirm = await f.queueCard('retry');
    vi.spyOn(f.store, 'getUserBinding').mockImplementationOnce(() => { throw new Error('Synthetic read failure'); });
    expect(await confirm()).toMatchObject({ toast: { type: 'error' } });
    expect(f.send).not.toHaveBeenCalled();
    await confirm();
    await confirm();
    retries = f.send.mock.calls.map(([device, frame]) => ({ device, threadId: frame.threadId, content: frame.content }));
    await f.text('/queue');
    expect(f.send).toHaveBeenLastCalledWith('original', expect.objectContaining({ content: '/queue', threadId: 'first-thread' }));
  });
  it('admits one retry on the same queue card after storage recovers', () => {
    expect(retries).toEqual([{ device: 'original', threadId: 'first-thread', content: expect.stringMatching(/^\/queue confirm retry \S+$/) }]);
  });
});

describe('queue confirmation before a CLI receipt', () => {
  let receipt: string;
  beforeAll(async () => {
    const f = await fixture();
    const confirm = await f.queueCard('pending');
    expect(await confirm()).toMatchObject({ toast: { content: expect.stringContaining('sent') } });
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.send).toHaveBeenCalledWith('original', expect.objectContaining({ content: expect.stringMatching(/^\/queue confirm pending /) }));
    receipt = f.sdk.patch.mock.lastCall![0].data.content;
    expect(await confirm()).toMatchObject({ toast: { content: expect.stringContaining('already processed') } });
    expect(f.send).toHaveBeenCalledOnce();
  });
  it('does not present a dispatched command as accepted by the CLI', () => {
    expect(receipt).not.toMatch(/>Queued<|was accepted into the thread queue/i);
  });
});
