import { cardThreadStorage } from './helpers/cardThreadStorage';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { Server } from 'http';
import Koa from 'koa';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { RouterServer } from '../src/server';
import type { ConfigManager } from '../src/config/ConfigManager';
import type { JsonStore } from '../src/storage/JsonStore';
import { FeishuLongConnHandler } from '../src/feishu/FeishuLongConnHandler';

vi.mock('ws');
vi.mock('../src/feishu/FeishuLongConnHandler');

type TestSocket = EventEmitter & {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  readyState: number;
};

describe.each(['claude', 'dsh', 'agy', 'codex', 'opencode', 'kimi', 'zcode', 'pi'])('Scheduled %s result delivery', backend => {
  let directory: string;
  let server: RouterServer;
  let wss: EventEmitter;
  let feishu: any;
  let owners: Map<string, string>;
  let bindingLookup: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'router-scheduled-result-')));
    vi.spyOn(os, 'homedir').mockReturnValue(directory);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(Koa.prototype, 'listen').mockReturnValue({
      close: (callback: () => void) => callback(),
    } as unknown as Server);
    wss = Object.assign(new EventEmitter(), { close: vi.fn() });
    vi.mocked(WebSocketServer).mockImplementation(() => wss as unknown as WebSocketServer);
    const config = {
      getConfigPath: () => path.join(directory, 'config.json'),
      get: (section: string, key: string) => section === 'files' ? { enabled: false } : key === 'heartbeatInterval' ? 30000 : 'test',
    };
    owners = new Map();
    server = new RouterServer(config as unknown as ConfigManager, {
      ...cardThreadStorage(), getDeviceThreadSelection: vi.fn(() => ({ status: 'none' })), flush: vi.fn().mockResolvedValue(undefined),
    } as unknown as JsonStore);
    bindingLookup = vi.spyOn((server as any).bindingManager, 'getDeviceBinding').mockImplementation(
      async (deviceId: string) => owners.has(deviceId) ? { openId: owners.get(deviceId) } : null,
    );
    await server.start();
    feishu = vi.mocked(FeishuLongConnHandler).mock.instances[0];
    feishu.sendStreamingStart.mockResolvedValue('schedule-card');
    feishu.finalizeStreamingMessage.mockResolvedValue(true);
    owners.set('device-1', 'owner');
  });

  afterEach(async () => {
    try { await server.stop(); }
    finally {
      vi.restoreAllMocks();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  function connect(): TestSocket {
    const socket = Object.assign(new EventEmitter(), {
      send: vi.fn(), close: vi.fn(), readyState: WebSocket.OPEN,
    }) as TestSocket;
    wss.emit('connection', socket, { socket: { remoteAddress: '127.0.0.1' } });
    return socket;
  }

  async function receive(socket: TestSocket, message: object): Promise<void> {
    await socket.listeners('message')[0](Buffer.from(JSON.stringify(message)));
  }

  async function register(socket: TestSocket, capabilities?: Record<string, boolean>): Promise<void> {
    await receive(socket, { type: 'binding_request', data: { deviceId: 'device-1', ...(capabilities ? { capabilities } : {}) } });
  }

  function replies(socket: TestSocket): any[] {
    return socket.send.mock.calls.map(call => JSON.parse(call[0]));
  }

  const epoch = '00000000-0000-4000-8000-000000000001';
  const capabilities = { queueStarted: true, taskRecovery: true, scheduleResultsV1: true, hostSchedulesV1: true };
  function start(overrides: Record<string, unknown> = {}) {
    return { type: 'queue_started', messageId: 'scheduled-result', openId: 'owner', threadId: 'original-thread',
      cwd: directory, queueStarted: { source: 'schedule', scheduleId: 'schedule-1', threadName: 'Original thread',
        bindingEpoch: epoch, backend, cwd: directory, preview: 'Review the project', remainingCount: 0 }, ...overrides };
  }
  function response(overrides: Record<string, unknown> = {}) {
    return { ...start(), type: 'response', success: true, output: 'Scheduled output', ...overrides };
  }
  function acks(socket: TestSocket) { return replies(socket).filter(message => message.type === 'task_result_ack'); }

  it.each([
    {}, { hostSchedulesV1: true }, { scheduleResultsV1: true }, { queueStarted: true, scheduleResultsV1: true },
    { taskRecovery: true, scheduleResultsV1: true }, { taskRecovery: true, queueStarted: true }, capabilities,
  ])('negotiates only the complete additive capability set (%j)', async requested => {
    const socket = connect(); await register(socket, requested);
    const confirmation = replies(socket).find(message => message.type === 'binding_confirm');
    expect(confirmation.data.capabilities?.scheduleResultsV1).toBe(requested === capabilities ? true : undefined);
    expect(confirmation.data.capabilities?.hostSchedulesV1).toBe(requested === capabilities ? true : undefined);
    expect(confirmation.data.scheduleBinding).toEqual(requested === capabilities ? { deviceId: 'device-1', openId: 'owner', epoch } : undefined);
    await receive(socket, start()); await receive(socket, response());
    expect(feishu.sendStreamingStart).toHaveBeenCalledTimes(requested === capabilities ? 1 : 0);
    expect(acks(socket)).toHaveLength(requested === capabilities ? 1 : 0);
    expect(feishu.sendMessage).not.toHaveBeenCalled();
  });

  it('limits legacy result negotiation to the original three backends', async () => {
    const socket = connect();
    await register(socket, { queueStarted: true, taskRecovery: true, scheduleResultsV1: true });
    const { bindingEpoch, ...queueStarted } = start().queueStarted;
    await receive(socket, start({ queueStarted })); await receive(socket, response({ queueStarted }));
    expect(acks(socket)).toHaveLength(['claude', 'agy', 'dsh'].includes(backend) ? 1 : 0);
  });

  it('requires the original epoch independently on both result frames', async () => {
    const socket = connect(); await register(socket, capabilities);
    const { bindingEpoch, ...withoutEpoch } = start().queueStarted;
    for (const queueStarted of [withoutEpoch, { ...withoutEpoch, bindingEpoch: 'different' }]) {
      await receive(socket, start({ queueStarted }));
    }
    expect(feishu.sendStreamingStart).not.toHaveBeenCalled();
    await receive(socket, start());
    for (const queueStarted of [withoutEpoch, { ...withoutEpoch, bindingEpoch: 'different' }]) {
      await receive(socket, response({ queueStarted }));
    }
    expect(feishu.finalizeStreamingMessage).not.toHaveBeenCalled();
    expect(acks(socket)).toHaveLength(0);
    await receive(socket, response());
    expect(acks(socket)).toHaveLength(1);
  });

  it('withholds an admitted result after same-user rebind and refuses its old epoch on reconnect', async () => {
    const socket = connect(); await register(socket, capabilities); await receive(socket, start());
    const nextEpoch = '00000000-0000-4000-8000-000000000002';
    feishu.finalizeStreamingMessage.mockImplementationOnce(async (...args: any[]) => {
      expect(await args[11].current()).toBe(true);
      vi.spyOn((server as any).bindingManager, 'getCardThreadEpoch').mockReturnValue(nextEpoch);
      expect(await args[11].current()).toBe(false);
      return true;
    });
    await receive(socket, response()); expect(acks(socket)).toHaveLength(0);
    const replacement = connect(); await register(replacement, capabilities);
    expect(replies(replacement).at(-1).data.scheduleBinding).toEqual({ openId: 'owner', deviceId: 'device-1', epoch: nextEpoch });
    await receive(replacement, start()); await receive(replacement, response());
    expect(acks(replacement)).toHaveLength(0);
    expect(feishu.sendStreamingStart).toHaveBeenCalledOnce();
    expect(feishu.finalizeStreamingMessage).toHaveBeenCalledOnce();
  });

  it('scopes completed receipts to the captured owner and thread across reconnection', async () => {
    const original = connect(); await register(original, capabilities);
    await receive(original, start()); await receive(original, response());
    const replacement = connect(); await register(replacement, capabilities);
    await receive(replacement, response({ threadId: 'other-thread' }));
    owners.set('device-1', 'new-owner');
    await receive(replacement, response({ openId: 'new-owner' }));
    await receive(replacement, start()); await receive(replacement, response());
    expect(acks(replacement)).toHaveLength(0);
    expect(feishu.sendStreamingStart).toHaveBeenCalledOnce();
    expect(feishu.finalizeStreamingMessage).toHaveBeenCalledOnce();
    expect(feishu.sendMessage).not.toHaveBeenCalled();
  });

  it('discards a card whose recipient lost ownership while creation was pending', async () => {
    const socket = connect(); await register(socket, capabilities);
    feishu.sendStreamingStart.mockImplementationOnce(async () => {
      owners.set('device-1', 'new-owner');
      return 'old-card';
    });
    await receive(socket, start());
    expect(feishu.sendStreamingStart.mock.calls[0][0]).toBe('owner');
    expect((server as any).streamingMessages.has('scheduled-result')).toBe(false);
    await receive(socket, response({ openId: 'new-owner' }));
    expect(feishu.finalizeStreamingMessage).not.toHaveBeenCalled();
    expect(acks(socket)).toHaveLength(0);
  });

  it('withholds the result receipt when binding changes during Feishu finalization', async () => {
    const socket = connect(); await register(socket, capabilities); await receive(socket, start());
    feishu.finalizeStreamingMessage.mockImplementationOnce(async (...args: any[]) => {
      expect(args[3]).toBe('owner');
      expect(await args[11].current()).toBe(true);
      owners.set('device-1', 'new-owner');
      expect(await args[11].current()).toBe(false);
      return true;
    });
    await receive(socket, response());
    expect(acks(socket)).toHaveLength(0);
    expect(feishu.sendMessage).not.toHaveBeenCalled();
  });

  it('renders the scheduled title and full result in the original thread without selecting it', async () => {
    const socket = connect(); await register(socket, capabilities);
    await receive(socket, start());
    const intro = feishu.sendStreamingStart.mock.calls[0][1];
    expect(intro).toContain('Scheduled task result'); expect(intro).toContain('Original thread');
    expect(intro).toContain(`**Backend:** ${backend}`);
    expect(intro).toContain('Review the project'); expect(intro).not.toContain('Queued task started');
    expect(intro).not.toContain('Remaining in queue');
    const resolveThread = feishu.setOnResolveThread.mock.calls[0][0];
    expect(await resolveThread('schedule-card', 'owner')).toMatchObject({ threadId: 'original-thread', deviceId: 'device-1' });
    expect(await resolveThread('schedule-card', 'other-owner')).toBeUndefined();
    expect(await feishu.setOnResolveActiveThread.mock.calls[0][0]('owner', 'device-1')).toBeUndefined();
    await receive(socket, response());
    const final = feishu.finalizeStreamingMessage.mock.calls[0];
    expect(JSON.stringify(final[1])).toContain('Scheduled output');
    expect(final[4]).toBe(directory); expect(final[7]).toBe('original-thread');
    expect(acks(socket)).toHaveLength(1);
  });

  it('retains both output and error for a failed scheduled occurrence', async () => {
    const socket = connect(); await register(socket, capabilities); await receive(socket, start());
    await receive(socket, response({ success: false, output: 'Partial result', error: 'Native task failed' }));
    const final = feishu.finalizeStreamingMessage.mock.calls[0];
    expect(JSON.stringify(final[1])).toContain('Partial result'); expect(JSON.stringify(final[1])).toContain('Native task failed');
    expect(final[10]).toBe(false); expect(final[11]).not.toHaveProperty('skippedBeforeAdmission');
    expect(acks(socket)).toHaveLength(1);
  });

  it('marks only an AGY skipped-before-admission result and acknowledges its retry without another card', async () => {
    const socket = connect(); await register(socket, capabilities); await receive(socket, start());
    await receive(socket, response({ success: false, skippedBeforeAdmission: true, error: 'Skipped before admission' }));
    if (backend !== 'agy') {
      expect(feishu.finalizeStreamingMessage).not.toHaveBeenCalled();
      expect(acks(socket)).toHaveLength(0);
      return;
    }
    const final = feishu.finalizeStreamingMessage.mock.calls[0];
    expect(final[10]).toBe(false);
    expect(final[11]).toMatchObject({ skippedBeforeAdmission: true });
    await receive(socket, response({ success: false, skippedBeforeAdmission: true, error: 'Skipped before admission' }));
    expect(feishu.finalizeStreamingMessage).toHaveBeenCalledOnce();
    expect(acks(socket)).toHaveLength(2);
  });

  it.each([
    { success: true, skippedBeforeAdmission: true },
    { success: false, skippedBeforeAdmission: false },
    { success: false, skippedBeforeAdmission: 'true' },
  ])('rejects an invalid skipped-before-admission flag %o', async invalid => {
    const socket = connect(); await register(socket, capabilities); await receive(socket, start());
    await receive(socket, response(invalid));
    expect(feishu.finalizeStreamingMessage).not.toHaveBeenCalled();
    expect(feishu.sendMessage).not.toHaveBeenCalled();
    expect(acks(socket)).toHaveLength(0);
  });

  it('deduplicates completed starts even after start-ID cleanup and acknowledges retried results', async () => {
    const socket = connect(); await register(socket, capabilities);
    await receive(socket, start()); await receive(socket, response());
    (server as any).startedQueueMessages.clear();
    const replacement = connect(); await register(replacement, capabilities);
    await receive(replacement, start()); await receive(replacement, response());
    expect(feishu.sendStreamingStart).toHaveBeenCalledOnce(); expect(feishu.finalizeStreamingMessage).toHaveBeenCalledOnce();
    expect(acks(replacement)).toHaveLength(1);
  });

  it('keeps ordinary queue behavior for a legacy peer without the new capability', async () => {
    const socket = connect(); await register(socket, { queueStarted: true });
    const frame = start(); const { source, scheduleId, bindingEpoch, ...legacy } = frame.queueStarted;
    await receive(socket, { ...frame, queueStarted: legacy });
    expect(feishu.sendStreamingStart.mock.calls[0][1]).toContain('Running');
    await receive(socket, { type: 'response', messageId: frame.messageId, openId: 'owner', success: true });
    expect(feishu.finalizeStreamingMessage).toHaveBeenCalledOnce(); expect(acks(socket)).toHaveLength(0);
  });

  it('recreates an unfinished scheduled card after disconnect cleanup and delivers its outbox retry', async () => {
    const socket = connect(); await register(socket, capabilities); await receive(socket, start());
    socket.emit('close', 1006, Buffer.from(''));
    await vi.waitFor(() => expect((server as any).streamingMessages.has('scheduled-result')).toBe(false));
    const replacement = connect(); await register(replacement, capabilities);
    feishu.sendStreamingStart.mockResolvedValue('replacement-card');
    await receive(replacement, start()); await receive(replacement, response());
    expect(feishu.sendStreamingStart).toHaveBeenCalledTimes(2);
    expect(feishu.finalizeStreamingMessage.mock.calls[0][0]).toBe('replacement-card');
    expect(acks(replacement)).toHaveLength(1);
  });

  it.each([
    { source: 'other' }, { scheduleId: '' }, { scheduleId: 's'.repeat(257) }, { threadName: 't'.repeat(101) },
    { preview: 'p'.repeat(241) }, { cwd: 'c'.repeat(4097) }, { backend: 'other' }, { remainingCount: 1 },
  ])('rejects invalid scheduled metadata (%j)', async invalid => {
    const socket = connect(); await register(socket, capabilities);
    const queueStarted = { ...start().queueStarted, ...invalid };
    await receive(socket, start({ queueStarted })); await receive(socket, response({ queueStarted }));
    expect(feishu.sendStreamingStart).not.toHaveBeenCalled(); expect(feishu.sendMessage).not.toHaveBeenCalled();
    expect(acks(socket)).toHaveLength(0);
  });

  it('rejects results with no admitted scheduled start', async () => {
    const socket = connect(); await register(socket, capabilities); await receive(socket, response());
    expect(feishu.sendMessage).not.toHaveBeenCalled(); expect(acks(socket)).toHaveLength(0);
  });

  it('rejects foreign recipients before card creation or receipt', async () => {
    const socket = connect(); await register(socket, capabilities);
    await receive(socket, start({ openId: 'other-owner' })); await receive(socket, response({ openId: 'other-owner' }));
    expect(feishu.sendStreamingStart).not.toHaveBeenCalled(); expect(acks(socket)).toHaveLength(0);
  });

  it('refuses response thread, schedule, backend or cwd changes without consuming the original result', async () => {
    const socket = connect(); await register(socket, capabilities); await receive(socket, start());
    await receive(socket, response({ threadId: 'other-thread' }));
    await receive(socket, response({ queueStarted: { ...start().queueStarted, scheduleId: 'other-schedule' } }));
    await receive(socket, response({ queueStarted: { ...start().queueStarted, backend: backend === 'claude' ? 'dsh' : 'claude' } }));
    const otherCwd = path.join(directory, 'other');
    await receive(socket, response({ cwd: otherCwd, queueStarted: { ...start().queueStarted, cwd: otherCwd } }));
    expect(feishu.finalizeStreamingMessage).not.toHaveBeenCalled(); expect(acks(socket)).toHaveLength(0);
    await receive(socket, response()); expect(acks(socket)).toHaveLength(1);
  });

  it('holds early results until card creation and validates the original thread after the barrier', async () => {
    const socket = connect(); await register(socket, capabilities);
    let release!: (id: string) => void;
    feishu.sendStreamingStart.mockReturnValue(new Promise<string>(resolve => { release = resolve; }));
    const starting = receive(socket, start());
    await vi.waitFor(() => expect(feishu.sendStreamingStart).toHaveBeenCalledOnce());
    const wrong = receive(socket, response({ threadId: 'other-thread' }));
    const correct = receive(socket, response());
    expect(feishu.finalizeStreamingMessage).not.toHaveBeenCalled(); expect(acks(socket)).toHaveLength(0);
    release('schedule-card'); await Promise.all([starting, wrong, correct]);
    expect(feishu.finalizeStreamingMessage).toHaveBeenCalledOnce(); expect(acks(socket)).toHaveLength(1);
  });

  it('does not acknowledge a failed card update and retries without duplicating output', async () => {
    const socket = connect(); await register(socket, capabilities); await receive(socket, start());
    feishu.finalizeStreamingMessage.mockResolvedValueOnce(false);
    await receive(socket, response()); expect(acks(socket)).toHaveLength(0);
    await receive(socket, start()); await receive(socket, response());
    expect(feishu.sendStreamingStart).toHaveBeenCalledOnce(); expect(acks(socket)).toHaveLength(1);
    expect(JSON.stringify(feishu.finalizeStreamingMessage.mock.calls[1][1]).match(/Scheduled output/g)).toHaveLength(1);
  });

  it('retries card creation failure without acknowledging an unthreaded fallback', async () => {
    const socket = connect(); await register(socket, capabilities);
    feishu.sendStreamingStart.mockResolvedValueOnce(null);
    await receive(socket, start()); await receive(socket, response());
    expect(acks(socket)).toHaveLength(0); expect(feishu.sendMessage).not.toHaveBeenCalled();
    await receive(socket, start()); await receive(socket, response());
    expect(feishu.sendStreamingStart).toHaveBeenCalledTimes(2); expect(acks(socket)).toHaveLength(1);
    expect(feishu.finalizeStreamingMessage.mock.calls[0][7]).toBe('original-thread');
  });

  it('does not acknowledge interrupted finalization after an ownership change', async () => {
    const socket = connect(); await register(socket, capabilities); await receive(socket, start());
    const stream = (server as any).streamingMessages.get('scheduled-result');
    let release!: () => void;
    stream.updateInFlight = new Promise<void>(resolve => { release = resolve; });
    const result = receive(socket, response()); await vi.waitFor(() => expect(stream.finalizing).toBe(true));
    owners.set('device-1', 'other-owner'); release(); await result;
    expect(feishu.finalizeStreamingMessage).not.toHaveBeenCalled(); expect(acks(socket)).toHaveLength(0);
  });
});
