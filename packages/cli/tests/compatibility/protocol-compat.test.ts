/**
 * Exercise the real CLI transport. Wire-contract failures require reviewing
 * CLAUDE.md's protocol versioning rules before changing expectations.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { WebSocketClient } from '../../src/client/WebSocketClient';
import { CLI_VERSION, PROTOCOL_VERSION } from '../../src/types';
import { buildReleaseIndex, releasePage } from '../../src/maintenance/ReleaseNotes';

vi.mock('ws');

describe('CLI wire compatibility', () => {
  let client: WebSocketClient;
  let socket: EventEmitter & { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; readyState: number };

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    socket = Object.assign(new EventEmitter(), { send: vi.fn(), close: vi.fn(), readyState: WebSocket.OPEN });
    vi.mocked(WebSocket).mockImplementation(() => socket as unknown as WebSocket);
    client = new WebSocketClient('ws://localhost:3000', 'device-1');
    const connecting = client.connect();
    socket.emit('open');
    await connecting;
  });

  afterEach(() => {
    client.disconnect();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('registers the device with its protocol version and queue-start capability', () => {
    expect(JSON.parse(socket.send.mock.calls[0][0])).toEqual({
      type: 'binding_request',
      messageId: expect.any(String),
      timestamp: expect.any(Number),
      data: { deviceId: 'device-1', protocolVersion: PROTOCOL_VERSION, capabilities: { queueStarted: true, taskRecovery: true, approvalCards: true, delegationProgress: true, delegationProgressText: true, workerContextReset: true, streamingContext: true, activityProgress: true, settingsCards: true, delegationCards: true, updateNotice: true, subscriptionInspection: true, bankedResetReminder: true } },
    });
  });

  it('sends the heartbeat wire format without a message id', async () => {
    await vi.advanceTimersByTimeAsync(15000);
    expect(JSON.parse(socket.send.mock.calls.at(-1)![0])).toEqual({
      type: 'heartbeat', timestamp: expect.any(Number),
    });
  });

  it.each([{}, { title: 'Run unit tests', description: 'Verify the change' }])('preserves additive per-call labels on the existing tool-use stream (%j)', labels => {
    const message = { type: 'stream', messageId: 'message-1', threadId: 'thread-1', streamType: 'tool_use',
      toolUse: { id: 'call-1', name: 'Bash', input: { command: 'npm test' }, ...labels } };
    client.send(message);
    const sent = JSON.parse(socket.send.mock.calls.at(-1)![0]);
    expect(sent).toEqual(message);
    expect(sent.toolUse.input).toEqual({ command: 'npm test' });
    expect(PROTOCOL_VERSION).toBe(1);
  });
  it('omits disabled maintenance capabilities without changing normal legacy traffic', async () => {
    const disabled = new WebSocketClient('ws://localhost:3000', 'device-1', {
      maintenanceCapabilities: { updateNotice: false, subscriptionInspection: false },
    });
    const connecting = disabled.connect(); socket.emit('open'); await connecting;
    const registration = JSON.parse(socket.send.mock.calls.at(-1)![0]);
    expect(registration.data.capabilities.updateNotice).toBeUndefined();
    expect(registration.data.capabilities.subscriptionInspection).toBeUndefined();
    expect(registration.data.capabilities.bankedResetReminder).toBeUndefined();
    expect(registration.data.capabilities.queueStarted).toBe(true);
    disabled.disconnect();
  });

  it('sends localized Markdown through the existing release-page fields with additive technical details', () => {
    const summary = '### \u66f4\u65b0\n- \u529f\u80fd\u6539\u5584';
    const index = buildReleaseIndex('## 1.6.124\n- Technical detail', '1.6.124', `## 1.6.124\n${summary.replace('- ', '- [feature|Feature] ')}`);
    const message = { type: 'update_notice', noticeKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      fromVersion: '1.6.123', toVersion: '1.6.124', page: releasePage(index, '1.6.123', '1.6.124') };
    client.send(message);
    expect(JSON.parse(socket.send.mock.calls.at(-1)![0])).toEqual(message);
    expect(message.page.sections[0]).toEqual({ version: '1.6.124', text: summary, details: '- Technical detail' });
    expect(message.page.overview).toMatchObject({ totalItems: 1, totalGroups: 1, groups: [{ topic: 'feature' }] });
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it.each([
    { success: true },
    { success: true, routerVersion: CLI_VERSION, minCliVersion: PROTOCOL_VERSION, futureField: 'ignored' },
  ])('accepts a binding confirmation with optional version metadata: %j', (data) => {
    const onMessage = vi.fn();
    client.onMessage(onMessage);
    const confirmation = { type: 'binding_confirm', messageId: 'registration', timestamp: 1000, data };
    socket.emit('message', Buffer.from(JSON.stringify(confirmation)));
    expect(onMessage).toHaveBeenCalledWith(confirmation);
    expect(client.isConnected()).toBe(true);
  });

  it('surfaces protocol rejection and stops reconnecting after the router closes the connection', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'error',
      data: { code: 'PROTOCOL_VERSION_INCOMPATIBLE', message: 'Please upgrade remote-cli.' },
    })));
    socket.emit('close', 1000, Buffer.from(''));
    await vi.advanceTimersByTimeAsync(15000);

    expect(error).toHaveBeenCalledWith(expect.stringContaining('Please upgrade remote-cli.'));
    expect(client.isConnected()).toBe(false);
    expect(WebSocket).toHaveBeenCalledTimes(1);
  });
});
