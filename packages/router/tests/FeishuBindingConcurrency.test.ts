import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { FeishuLongConnHandler } from '../src/feishu/FeishuLongConnHandler';
import { BindingManager } from '../src/binding/BindingManager';
import { JsonStore } from '../src/storage/JsonStore';

vi.mock('@larksuiteoapi/node-sdk', async importOriginal => ({
  ...(await importOriginal<object>()),
  Client: vi.fn().mockImplementation(() => ({})),
}));
const originalHomedir = os.homedir.bind(os);
vi.spyOn(os, 'homedir').mockImplementation(() => process.env.HOME || originalHomedir());

describe('Feishu binding command concurrency', () => {
  let directory: string;
  let store: JsonStore;
  let manager: BindingManager;
  let handler: FeishuLongConnHandler;

  beforeEach(async () => {
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'remote-cli-feishu-binding-')));
    store = new JsonStore(path.join(directory, 'bindings.json'), 0);
    await store.initialize();
    handler = new FeishuLongConnHandler({ appId: 'synthetic-app', appSecret: 'synthetic-secret', store });
    manager = (handler as any).bindingManager;
    vi.spyOn(handler as any, 'replyToMessage').mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await store.flush();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('admits only one of two real concurrent cross-user bind commands for one code', async () => {
    const issued = await manager.generateBindingCode('device-a', 'Device', 'public-key');
    let releaseApproval!: () => void;
    const gate = new Promise<void>(resolve => { releaseApproval = resolve; });
    let approvalStarted!: () => void;
    const started = new Promise<void>(resolve => { approvalStarted = resolve; });
    const approve = vi.fn(async () => { approvalStarted(); await gate; });
    handler.onApproveDeviceKey = approve;

    const first = (handler as any).handleBindCommand('user-a', 'message-a', issued.code);
    await started;
    const second = (handler as any).handleBindCommand('user-b', 'message-b', issued.code);
    releaseApproval();
    await Promise.all([first, second]);

    const replies = vi.mocked((handler as any).replyToMessage).mock.calls.map(call => call[1]);
    expect(replies.filter(text => text.includes('Device key approved'))).toHaveLength(1);
    expect(replies.filter(text => text.includes('invalid or expired') || text.includes('Binding failed'))).toHaveLength(1);
    expect(approve).toHaveBeenCalledTimes(1);
    expect(store.getUserByDeviceId('device-a')).toBe('user-a');
    expect(store.getUserBinding('user-b')).toBeNull();
    expect(store.getBindingCode(issued.code)).toBeNull();
  });

  it('preserves legacy binding replies while consuming a normal code once', async () => {
    const approve = vi.fn();
    handler.onApproveDeviceKey = approve;
    const issued = await manager.generateBindingCode('device-a', 'Device');
    await (handler as any).handleBindCommand('user-a', 'message-a', issued.code);

    expect(approve).not.toHaveBeenCalled();
    expect(vi.mocked((handler as any).replyToMessage)).toHaveBeenCalledWith('message-a', expect.stringContaining('Binding successful'));
    expect(store.getUserBinding('user-a')?.activeDeviceId).toBe('device-a');
    expect(store.getBindingCode(issued.code)).toBeNull();
  });
});
