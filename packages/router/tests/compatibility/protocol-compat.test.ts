/**
 * Exercise RouterServer's actual WebSocket handlers without opening sockets.
 * Wire-contract failures require reviewing CLAUDE.md's protocol versioning rules.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { Server } from 'http';
import Koa from 'koa';
import { WebSocket, WebSocketServer } from 'ws';
import { RouterServer } from '../../src/server';
import type { ConfigManager } from '../../src/config/ConfigManager';
import type { JsonStore } from '../../src/storage/JsonStore';
import { FeishuLongConnHandler } from '../../src/feishu/FeishuLongConnHandler';
import { MIN_SUPPORTED_CLI_VERSION, PROTOCOL_VERSION, ROUTER_VERSION } from '../../src/types';

vi.mock('ws');
vi.mock('../../src/feishu/FeishuLongConnHandler');

describe('Router wire compatibility', () => {
  let server: RouterServer;
  let wss: EventEmitter;
  let socket: EventEmitter & { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; readyState: number };
  let receive: (message: object) => Promise<void>;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(Koa.prototype, 'listen').mockReturnValue({
      close: (callback: () => void) => callback(),
    } as unknown as Server);
    wss = Object.assign(new EventEmitter(), { close: vi.fn() });
    vi.mocked(WebSocketServer).mockImplementation(() => wss as unknown as WebSocketServer);
    const config = {
      getConfigPath: () => '/virtual-router-compat/config.json',
      get: (section: string, key: string) => section === 'files' ? { enabled: false } : key === 'heartbeatInterval' ? 30000 : 'test',
    };
    server = new RouterServer(config as unknown as ConfigManager, {} as JsonStore);
    await server.start();

    socket = Object.assign(new EventEmitter(), { send: vi.fn(), close: vi.fn(), readyState: WebSocket.OPEN });
    wss.emit('connection', socket, { socket: { remoteAddress: '127.0.0.1' } });
    const onMessage = socket.listeners('message')[0];
    receive = async (message) => { await onMessage(Buffer.from(JSON.stringify(message))); };
  });

  afterEach(async () => {
    await server.stop();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    { label: 'legacy CLI without optional metadata', metadata: {}, supportsQueueStarted: false },
    {
      label: 'current CLI with additive metadata',
      metadata: { protocolVersion: PROTOCOL_VERSION, capabilities: { queueStarted: true, futureFeature: true }, futureField: 'ignored' },
      supportsQueueStarted: true,
    },
  ])('registers and confirms a $label', async ({ metadata, supportsQueueStarted }) => {
    await receive({
      type: 'binding_request', messageId: 'registration', timestamp: 1000,
      data: { deviceId: 'device-1', ...metadata },
    });
    expect(JSON.parse(socket.send.mock.calls[0][0])).toEqual({
      type: 'binding_confirm', messageId: 'registration', timestamp: expect.any(Number),
      data: { success: true, routerVersion: ROUTER_VERSION, minCliVersion: MIN_SUPPORTED_CLI_VERSION },
    });
    const feishu = vi.mocked(FeishuLongConnHandler).mock.instances[0];
    const hub = vi.mocked(feishu.setConnectionHub).mock.calls[0][0];
    expect(hub.isDeviceOnline('device-1')).toBe(true);
    expect(hub.supportsQueueStarted('device-1')).toBe(supportsQueueStarted);
    expect(socket.close).not.toHaveBeenCalled();
  });

  it('opts into early streaming context without changing the protocol baseline', async () => {
    await receive({ type: 'binding_request', messageId: 'registration', data: {
      deviceId: 'device-1', protocolVersion: 1, capabilities: { streamingContext: true },
    } });
    expect(JSON.parse(socket.send.mock.calls[0][0])).toMatchObject({
      type: 'binding_confirm', data: { success: true, minCliVersion: 1, capabilities: { streamingContext: true } },
    });
    const feishu = vi.mocked(FeishuLongConnHandler).mock.instances[0];
    vi.mocked(feishu.setOnStartStreaming).mock.calls[0][0]('early', 'owner', 'card', 'device-1');
    await receive({ type: 'stream_context', messageId: 'early', openId: 'owner',
      threadId: 'thread-id', threadName: 'thread-9', cwd: '/project' });
    expect(feishu.updateStreamingMessage).toHaveBeenCalledWith('card', expect.any(Array), 'owner', 'thread-9', '/project');
  });
  it('negotiates standalone maintenance messages only for opted-in registered current devices', async () => {
    const maintenance = (server as any).maintenanceCards;
    const notice = vi.spyOn(maintenance, 'receiveNotice').mockResolvedValue(undefined);
    const reminder = vi.spyOn(maintenance, 'receiveReminder').mockResolvedValue(undefined);
    await receive({ type: 'update_notice', noticeKey: 'unregistered' }); expect(notice).not.toHaveBeenCalled();
    await receive({ type: 'binding_request', data: { deviceId: 'device-1', protocolVersion: 1,
      capabilities: { updateNotice: true, subscriptionInspection: true } } });
    expect(JSON.parse(socket.send.mock.calls[0][0])).toMatchObject({ type: 'binding_confirm',
      data: { minCliVersion: 1, capabilities: { updateNotice: true, subscriptionInspection: true } } });
    const update = { type: 'update_notice', noticeKey: 'fixture', page: {
      coverage: 'complete', offset: 0, totalSections: 1,
      sections: [{ version: '1.6.127', text: '### \u66f4\u65b0\n- \u529f\u80fd\u6539\u5584', details: '- Technical detail' }],
      overview: { totalGroups: 1, totalItems: 1, groups: [{ topic: 'feature', title: 'Feature', items: ['A change'] }] },
    } };
    await receive(update);
    await receive({ type: 'subscription_reminder', reminder: {} });
    expect(notice).toHaveBeenCalledWith(update, 'device-1', expect.any(Function));
    expect(reminder).toHaveBeenCalledTimes(1);
    expect((server as any).streamingMessages.size).toBe(0);
    expect((server as any).cardThreadMap.size).toBe(0); expect((server as any).activeThreadMap.size).toBe(0);
  });
  it('does not send maintenance messages or capabilities to a legacy client', async () => {
    const maintenance = (server as any).maintenanceCards;
    const notice = vi.spyOn(maintenance, 'receiveNotice').mockResolvedValue(undefined);
    await receive({ type: 'binding_request', data: { deviceId: 'device-1' } });
    expect(JSON.parse(socket.send.mock.calls[0][0]).data.capabilities).toBeUndefined();
    await receive({ type: 'update_notice', noticeKey: 'fixture' }); expect(notice).not.toHaveBeenCalled();
  });
  it.each([
    { capabilities: { settingsCards: true }, enabled: false },
    { capabilities: { delegationCards: true }, enabled: false },
    { capabilities: { settingsCards: true, delegationCards: true }, enabled: true },
  ])('requires additive opt-in for delegation settings without changing protocol v1 ($enabled)', async ({ capabilities, enabled }) => {
    await receive({ type: 'binding_request', data: { deviceId: 'device-1', protocolVersion: 1, capabilities } });
    expect(JSON.parse(socket.send.mock.calls[0][0]).data.capabilities?.delegationCards).toBe(enabled ? true : undefined);
    expect((server as any).settingsConnections.get('device-1')?.('delegation') === true).toBe(enabled);
    expect(PROTOCOL_VERSION).toBe(1);
  });
  it.each([
    { capabilities: { subscriptionInspection: true }, enabled: false },
    { capabilities: { bankedResetReminder: true }, enabled: false },
    { capabilities: { subscriptionInspection: true, bankedResetReminder: true }, enabled: true },
  ])('requires explicit additive opt-in for banked reset reminders: $enabled', async ({ capabilities, enabled }) => {
    const maintenance = (server as any).maintenanceCards;
    const reminder = vi.spyOn(maintenance, 'receiveReminder').mockResolvedValue(undefined);
    await receive({ type: 'binding_request', data: { deviceId: 'device-1', protocolVersion: 1, capabilities } });
    expect(JSON.parse(socket.send.mock.calls[0][0]).data.capabilities?.bankedResetReminder).toBe(enabled ? true : undefined);
    const message = { type: 'subscription_reminder', reminder: { kind: 'banked_reset_increase' } };
    await receive(message); expect(reminder).toHaveBeenCalledTimes(enabled ? 1 : 0);
    expect((server as any).streamingMessages.size).toBe(0);
    expect((server as any).cardThreadMap.size).toBe(0);
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('negotiates additive approval cards and routes a button response to the original request', async () => {
    await receive({ type: 'binding_request', messageId: 'registration', data: {
      deviceId: 'device-1', protocolVersion: PROTOCOL_VERSION, capabilities: { approvalCards: true, taskRecovery: true },
    } });
    expect(JSON.parse(socket.send.mock.calls[0][0]).data.capabilities).toEqual({ approvalCards: true, taskRecovery: true });
    const feishu = vi.mocked(FeishuLongConnHandler).mock.instances[0];
    vi.spyOn((server as any).bindingManager, 'getDeviceBinding').mockResolvedValue({ openId: 'owner' });
    vi.mocked(feishu.sendTaskNotificationCard).mockResolvedValue('approval-card');
    const message = { type: 'approval_request', messageId: 'approval-1', taskMessageId: 'task', openId: 'owner',
      threadId: 'thread-2', threadName: 'thread-2', cwd: '/project', timestamp: 1,
      approval: { requestId: 'approval-1', kind: 'command', description: 'install', canRemember: false } };
    await receive(message);
    expect(feishu.sendTaskNotificationCard).toHaveBeenCalledWith('owner', expect.any(Array), expect.objectContaining({ template: 'blue' }));
    await feishu.onApprovalAction!('owner', 'approval-1', 'approval-card', 'approve');
    expect(socket.send.mock.calls.map(call => JSON.parse(call[0]))).toContainEqual(expect.objectContaining({
      type: 'approval_response', messageId: 'approval-1', taskMessageId: 'task', threadId: 'thread-2', action: 'approve',
    }));
    await receive({ type: 'approval_resolved', messageId: 'approval-1', openId: 'owner', threadId: 'thread-2', status: 'approved' });
    expect(JSON.stringify(vi.mocked(feishu.updateApprovalCard).mock.calls.at(-1))).toContain('Approved');
  });

  it('negotiates nested delegated-worker text only when the CLI advertises the additive capability', async () => {
    await receive({ type: 'binding_request', messageId: 'registration', data: {
      deviceId: 'device-1', protocolVersion: PROTOCOL_VERSION,
      capabilities: { delegationProgress: true, delegationProgressText: true },
    } });

    expect(JSON.parse(socket.send.mock.calls[0][0]).data.capabilities).toEqual({
      delegationProgress: true,
      delegationProgressText: true,
    });
  });

  it('serves a legacy CLI alongside a current CLI without requiring new capabilities', async () => {
    await receive({ type: 'binding_request', messageId: 'legacy-registration', data: { deviceId: 'legacy-device' } });
    const currentSocket = Object.assign(new EventEmitter(), { send: vi.fn(), close: vi.fn(), readyState: WebSocket.OPEN });
    wss.emit('connection', currentSocket, { socket: { remoteAddress: '127.0.0.2' } });
    const onCurrentMessage = currentSocket.listeners('message')[0];
    const receiveCurrent = async (message: object) => { await onCurrentMessage(Buffer.from(JSON.stringify(message))); };
    await receiveCurrent({ type: 'binding_request', messageId: 'current-registration', data: {
      deviceId: 'current-device', protocolVersion: 1,
      capabilities: { queueStarted: true, taskRecovery: true, approvalCards: true },
    } });

    const feishu = vi.mocked(FeishuLongConnHandler).mock.instances[0];
    const hub = vi.mocked(feishu.setConnectionHub).mock.calls[0][0];
    const startStreaming = vi.mocked(feishu.setOnStartStreaming).mock.calls[0][0];
    const legacyCommand = { type: 'command', messageId: 'legacy-task', openId: 'legacy-user', content: 'Inspect the project', timestamp: 1000 };
    const currentCommand = { type: 'command', messageId: 'current-task', openId: 'current-user', threadId: 'thread-2', content: 'Delegate a review', timestamp: 1000 };
    startStreaming('legacy-task', 'legacy-user', 'legacy-card', 'legacy-device');
    startStreaming('current-task', 'current-user', 'current-card', 'current-device', 'thread-2');
    expect(await hub.sendToDevice('legacy-device', legacyCommand)).toBe(true);
    expect(await hub.sendToDevice('current-device', currentCommand)).toBe(true);
    expect(JSON.parse(socket.send.mock.calls.at(-1)![0])).toEqual(legacyCommand);
    expect(JSON.parse(currentSocket.send.mock.calls.at(-1)![0])).toEqual(currentCommand);

    await receive({ type: 'stream', messageId: 'legacy-task', openId: 'legacy-user', chunk: 'Legacy progress' });
    await receiveCurrent({ type: 'stream', messageId: 'current-task', openId: 'current-user', streamType: 'tool_use',
      toolUse: { id: 'delegated-task', name: 'Task', input: { description: 'Review the project', subagent_type: 'codex' } } });
    await receiveCurrent({ type: 'stream', messageId: 'current-task', openId: 'current-user', streamType: 'tool_result',
      toolResult: { tool_use_id: 'delegated-task', content: 'Delegated review complete' } });
    await receiveCurrent({ type: 'stream', messageId: 'current-task', openId: 'current-user', streamType: 'tool_use',
      toolUse: { id: 'web-native', name: 'WebSearch', input: { query: 'docs' } } });
    await receiveCurrent({ type: 'stream', messageId: 'current-task', openId: 'current-user', streamType: 'tool_result',
      toolResult: { tool_use_id: 'web-native', content: 'Documentation\nhttps://example.com/docs', is_error: false,
        webSearch: { results: [{ title: 'Documentation', url: 'https://example.com/docs', snippet: 'Public excerpt' }], omittedResults: 0 } } });
    await receive({ type: 'response', messageId: 'legacy-task', data: { openId: 'legacy-user', success: true, output: 'Legacy progress' } });
    await receiveCurrent({ type: 'response', messageId: 'current-task', openId: 'current-user', threadId: 'thread-2', success: true });

    const finalCards = vi.mocked(feishu.finalizeStreamingMessage).mock.calls;
    expect(finalCards).toHaveLength(2);
    expect(finalCards[0][0]).toBe('legacy-card');
    expect(JSON.stringify(finalCards[0][1])).toContain('Legacy progress');
    expect(finalCards[0][3]).toBe('legacy-user');
    expect(finalCards[1][0]).toBe('current-card');
    expect(JSON.stringify(finalCards[1][1])).toContain('Delegated review complete');
    expect(JSON.stringify(finalCards[1][1])).toContain('[Open source](https://example.com/docs)');
    expect(JSON.stringify(finalCards[1][1])).toContain('Public excerpt');
    expect(finalCards[1][3]).toBe('current-user');
    expect(socket.send.mock.calls.map(([value]) => JSON.parse(value).type)).toEqual(['binding_confirm', 'command']);
    expect(currentSocket.send.mock.calls.map(([value]) => JSON.parse(value).type)).toEqual(['binding_confirm', 'command', 'task_result_ack']);
    expect(hub.supportsQueueStarted('legacy-device')).toBe(false);
    expect(hub.supportsQueueStarted('current-device')).toBe(true);
    expect(socket.close).not.toHaveBeenCalled();
    expect(currentSocket.close).not.toHaveBeenCalled();
  });

  it.each([{}, { workerContextReset: true }, { delegationProgress: true, workerContextReset: true }])
    ('negotiates context reset only with worker progress: %j', async capabilities => {
      await receive({ type: 'binding_request', messageId: 'registration', data: { deviceId: 'device-1', capabilities } });
      const confirmation = JSON.parse(socket.send.mock.calls[0][0]);
      expect(confirmation.data.minCliVersion).toBe(1);
      expect(confirmation.data.capabilities?.workerContextReset).toBe(capabilities.delegationProgress ? true : undefined);
    });

  it('rejects an unsupported CLI before registering it and explains how to recover', async () => {
    await receive({
      type: 'binding_request', messageId: 'registration', timestamp: 1000,
      data: { deviceId: 'device-1', protocolVersion: MIN_SUPPORTED_CLI_VERSION - 1 },
    });
    expect(JSON.parse(socket.send.mock.calls[0][0])).toEqual({
      type: 'error', messageId: 'registration', timestamp: expect.any(Number),
      data: {
        code: 'PROTOCOL_VERSION_INCOMPATIBLE',
        message: expect.stringContaining('Please upgrade remote-cli'),
        minimumVersion: MIN_SUPPORTED_CLI_VERSION,
        currentRouterVersion: PROTOCOL_VERSION,
      },
    });
    const feishu = vi.mocked(FeishuLongConnHandler).mock.instances[0];
    const hub = vi.mocked(feishu.setConnectionHub).mock.calls[0][0];
    expect(hub.isDeviceOnline('device-1')).toBe(false);
    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it('responds to a CLI heartbeat that has no message id', async () => {
    await receive({ type: 'heartbeat', timestamp: 1000 });
    expect(JSON.parse(socket.send.mock.calls[0][0])).toEqual({
      type: 'heartbeat', timestamp: expect.any(Number), data: {},
    });
  });
});
