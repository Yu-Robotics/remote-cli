import { randomUUID } from 'crypto';
import { once } from 'events';
import { readFileSync } from 'fs';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'fs/promises';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import Koa from 'koa';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RouterServer } from '../../../router/src/server';
import { FeishuLongConnHandler } from '../../../router/src/feishu/FeishuLongConnHandler';
import { JsonStore } from '../../../router/src/storage/JsonStore';
import type { ConfigManager as RouterConfig } from '../../../router/src/config/ConfigManager';
import { DEFAULT_CONFIG } from '../../../router/src/types/config';
import { MessageHandler } from '../../src/client/MessageHandler';
import { WebSocketClient } from '../../src/client/WebSocketClient';
import { ConfigManager } from '../../src/config/ConfigManager';
import type { ExecuteOptions } from '../../src/executor/IExecutor';
import type { ManagedToolConnection } from '../../src/managed/contract';
import { ScheduleDeliveryClient } from '../../src/scheduling/ScheduleDeliveryClient';
import { ScheduleService, HOST_SCHEDULE_CATALOG_FILE } from '../../src/scheduling/ScheduleService';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { ThreadExecutorPool, type ExecutorFactory } from '../../src/thread/ThreadExecutorPool';
import { ThreadManager } from '../../src/thread/ThreadManager';
import type { QueueStartedInfo } from '../../src/types';
import { backendKeyOf } from '../../src/types/config';

vi.mock('../../../router/src/feishu/FeishuLongConnHandler');

const deviceId = 'fixture-device';
const openId = 'fixture-owner';
const threadName = 'scheduled-thread';
const task = 'Report the fixture status';
const hour = Date.parse('2030-01-07T08:00:00Z');
const minute = 60_000;
const wait = { timeout: 3000, interval: 10 };
const backends = ['claude', 'dsh', 'agy', 'codex', 'kimi', 'opencode', 'pi', 'zcode'] as const;
type Backend = typeof backends[number];
const reminder = 'At 08:01 UTC on January 7, 2030, report the fixture status here.';
const otherOwner = 'fixture-other-owner';

function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function fixture(root: string, backend: Backend) {
  const store = new JsonStore(path.join(root, 'bindings.json'), 0);
  await store.initialize();
  const bind = (owner: string) => store.setUserBinding(owner, {
    openId: owner, createdAt: hour, updatedAt: hour, activeDeviceId: deviceId,
    devices: [{ deviceId, deviceName: 'Fixture', boundAt: hour, lastActiveAt: hour, isActive: true }],
  });
  await bind(openId);
  const values = { ...DEFAULT_CONFIG, server: { ...DEFAULT_CONFIG.server, host: '127.0.0.1', port: 0 },
    files: { enabled: false }, tips: { enabled: false }, websocket: { heartbeatInterval: 60 * minute } };
  const config = { getConfigPath: () => path.join(root, 'router.json'),
    get(section: keyof typeof values, key?: string) {
      return key ? Reflect.get(values[section], key) : values[section];
    } };
  const listen = vi.spyOn(Koa.prototype, 'listen');
  const router = new RouterServer(config as RouterConfig, store);
  const feishu = vi.mocked(vi.mocked(FeishuLongConnHandler).mock.instances[0]);
  const hub = feishu.setConnectionHub.mock.calls[0][0];
  feishu.sendStreamingStart.mockImplementation(async (...args) => `card-${args[4]}`);
  feishu.finalizeStreamingMessage.mockResolvedValue(true);
  await router.start();

  let client: WebSocketClient | undefined;
  let handler: MessageHandler | undefined;
  let replyGate: ReturnType<typeof latch> | undefined;
  async function stopCli() {
    replyGate?.release();
    client?.disconnect();
    await handler?.destroy();
    handler = undefined;
  }
  async function close() {
    try { await stopCli(); } finally { await router.stop(); }
  }
  try {
    const http: Server = listen.mock.results[0].value;
    if (!http.listening) await once(http, 'listening');
    const url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}/ws`;
    const setup = await ConfigManager.initialize();
    await setup.set('serverUrl', url);
    await setup.set('deviceId', deviceId);
    await setup.set('executor.type', backend === 'claude' ? 'claude-persistent' : backend);
    const threads = await ThreadManager.initialize(root);
    const thread = await threads.createThread(threadName, root, backend);
    const sessionId = randomUUID();
    await threads.updateThread(thread.id, { sessionId, delegation: false });
    // A provider's saved selection can disagree with the CLI's thread metadata.
    const selection = (id: string) => path.join(root, `native-selection-${id}`);
    await writeFile(selection(thread.id), sessionId);
    const turns: { backend: string; threadId: string; sessionId: string; prompt: string; at: number }[] = [];
    const checked = vi.fn((expected: string, selected: string) => {
      if (expected !== selected) throw new Error('Fixture native session changed');
    });
    const nativeCreate = vi.fn(async (): Promise<never> => {
      throw new Error('Host-timed creation called the native schedule provider');
    });
    const nativeManagement = vi.fn();
    const managedCreates: { status: string; scheduleId?: string; error?: string }[] = [];
    const factory: ExecutorFactory = (_guard, effective, cwd, id) => {
      if (!cwd || !id) throw new Error('Missing executor thread');
      const selected = () => readFileSync(selection(id), 'utf8');
      let connection: ManagedToolConnection | undefined;
      return {
        configureManagedTools: async value => { connection = value; },
        getSessionId: () => selected(),
        getCurrentWorkingDirectory: () => cwd,
        checkHostScheduleSession: (expected: string) => checked(expected, selected()),
        execute: async (prompt: string, options?: ExecuteOptions) => {
          const sessionId = selected();
          const resolved = options?.resolvePrompt?.(sessionId) ?? prompt;
          const number = turns.push({ backend: backendKeyOf(effective.type), threadId: id, sessionId,
            prompt: resolved, at: Date.now() });
          if (resolved.includes(reminder)) {
            if (!connection?.groups?.includes('scheduling')) throw new Error('Scheduling tools were not registered');
            const call = async (name: string, args: Record<string, unknown>) => {
              const response = await fetch(connection!.url, { method: 'POST', headers: {
                authorization: `Bearer ${connection!.token}`, 'content-type': 'application/json',
              }, body: JSON.stringify({ name, args, callId: randomUUID() }) });
              if (!response.ok) throw new Error(`Managed tool request failed: ${response.status}`);
              return response.json();
            };
            const args = { requestId: 'fixture-reminder', when: { kind: 'at', at: '2030-01-07T08:01:00Z' }, prompt: task };
            let result = await call('remote_cli_schedule_create', args);
            if (result.status === 'pending') result = await call('remote_cli_schedule_operation', { requestId: args.requestId });
            managedCreates.push(result);
          }
          await replyGate?.promise;
          return { success: true, output: `Provider reply ${number}` };
        },
        withNativeScheduleOperation: async (_id, current, run) => {
          nativeManagement();
          if (!current()) throw new Error('Stale native operation');
          return run();
        },
        createNativeSchedule: nativeCreate,
        resetContext: vi.fn(), isBusy: () => false, setWorkingDirectory: vi.fn(), abort: async () => true,
        destroy: vi.fn(),
      };
    };
    const guard = new DirectoryGuard([root]);
    const acks: string[] = [];
    const droppedAcks = new Set<string>();
    const resultAttempts: string[] = [];
    let loseScheduleAcks = false;
    const responses = new Map<string, { success: boolean; error?: string; output?: string; queueStarted?: QueueStartedInfo;
      scheduleMenu?: { entries: { id: string }[] } }>();
    const initialization = vi.spyOn(ScheduleService.prototype, 'initialize');
    async function startCli(reloadCatalog = false) {
      initialization.mockClear();
      const config = await ConfigManager.initialize();
      const manager = await ThreadManager.initialize(root);
      const pool = new ThreadExecutorPool(manager, guard, config.get('executor'), factory);
      const ws = new WebSocketClient(url, deviceId, { heartbeatInterval: 60 * minute });
      const subscribe = ws.onTaskResultAck.bind(ws);
      vi.spyOn(ws, 'onTaskResultAck').mockImplementation(listener => subscribe(id => {
        if (loseScheduleAcks && resultAttempts.includes(id)) droppedAcks.add(id);
        else listener(id);
      }));
      client = ws;
      const current = new MessageHandler(ws, pool, manager, guard, config);
      handler = current;
      await current.prepareScheduleStartup();
      const send = ws.send.bind(ws);
      vi.spyOn(ws, 'send').mockImplementation(frame => {
        const sent = send(frame);
        if (sent && frame.type === 'response') responses.set(frame.messageId, frame);
        if (sent && frame.type === 'response' && frame.queueStarted?.source === 'schedule') resultAttempts.push(frame.messageId);
        return sent;
      });
      let registered = false;
      ws.onTaskResultAck(id => acks.push(id));
      ws.onMessage(async message => {
        await current.handleMessage(message);
        if (message.type === 'binding_confirm') registered = message.data.capabilities?.scheduleResultsV1 === true;
      });
      await ws.connect();
      await vi.waitFor(() => expect(registered).toBe(true), wait);
      if (reloadCatalog) {
        // Binding can finish before the async startup catalog read arms the timer.
        await vi.waitFor(() => expect(initialization).toHaveBeenCalled(), wait);
        await initialization.mock.results[0].value;
      }
    }
    await startCli();
    async function request(content: string, owner = openId) {
      const messageId = randomUUID();
      expect(await hub.sendToDevice(deviceId, { type: 'command', messageId, openId: owner, threadId: thread.id,
        content, isSlashCommand: content.startsWith('/'), timestamp: Date.now() })).toBe(true);
      await vi.waitFor(() => expect(responses.has(messageId)).toBe(true), wait);
      return responses.get(messageId)!;
    }
    async function command(content: string) {
      const response = await request(content);
      expect(response.success, response.error).toBe(true);
      return response;
    }
    async function catalogPath() {
      const schedules = path.join(setup.getConfigDir(), 'schedules');
      const namespaces = await readdir(schedules);
      expect(namespaces).toHaveLength(1);
      return path.join(schedules, namespaces[0], HOST_SCHEDULE_CATALOG_FILE);
    }
    async function catalog() {
      return JSON.parse(await readFile(await catalogPath(), 'utf8')) as {
        records: { id: string; state: string }[];
        pending: { id: string; scheduleId: string; output?: string }[];
      };
    }
    async function create(rule: string) {
      const response = await command(`/schedule ${rule} -- ${task}`);
      const entries = response.scheduleMenu?.entries;
      expect(entries).toHaveLength(1);
      const id = entries![0].id;
      expect((await catalog()).records).toContainEqual(expect.objectContaining({
        id, engine: 'host', backend, openId, threadId: thread.id, sessionId, state: 'active',
      }));
      expect(nativeCreate).not.toHaveBeenCalled();
      expect(turns).toHaveLength(0);
      return id;
    }
    async function settleDelivery() {
      // The WebSocket ACK precedes atomic catalog replacement. Opening the file
      // concurrently with rename can prevent the replacement on Windows.
      const service = initialization.mock.instances.at(-1);
      if (service) await service['deliveryTail'];
    }
    async function receipt(index: number, scheduleId: string, output: string, cardExpired = false) {
      const starts = () => feishu.sendStreamingStart.mock.calls.filter(([, intro]) => intro?.includes('Scheduled task result'));
      await vi.waitFor(() => expect(starts()).toHaveLength(index + 1), wait);
      const [owner, intro, name, cwd, id] = starts()[index];
      expect([owner, name, cwd]).toEqual([openId, threadName, root]);
      expect(intro).toContain(task);
      expect(intro).toContain(`**Backend:** ${backend}`);
      expect(id).toEqual(expect.any(String));
      await vi.waitFor(() => expect(acks.filter(ack => ack === id)).toHaveLength(1), wait);
      await settleDelivery();
      expect(responses.get(id!)).toMatchObject({ success: true, output, queueStarted: { source: 'schedule', scheduleId } });
      const finals = feishu.finalizeStreamingMessage.mock.calls.filter(([card]) => card === `card-${id}`);
      expect(finals).toHaveLength(1);
      const [, elements, , recipient, directory, , , replyThread] = finals[0];
      expect([recipient, directory, replyThread]).toEqual([openId, root, thread.id]);
      expect(JSON.stringify(elements)).toContain(output);
      const cardThread = await feishu.setOnResolveThread.mock.calls[0][0](`card-${id}`, openId);
      if (cardExpired) expect(cardThread).toBeUndefined();
      else expect(cardThread).toMatchObject({ threadId: thread.id, deviceId });
      return id!;
    }
    function expectTurn(index: number, due: number) {
      const turn = turns[index];
      expect(turn).toMatchObject({ backend, sessionId, threadId: thread.id, prompt: expect.stringContaining(task) });
      expect(turn.at).toBeGreaterThanOrEqual(due);
      expect(turn.at).toBeLessThan(due + minute);
      expect(checked).toHaveBeenCalledWith(sessionId, sessionId);
    }
    return { create, command, request, catalog, receipt, settleDelivery, expectTurn, turns, acks, checked, sessionId, thread, feishu, close,
      nativeCreate, nativeManagement, managedCreates,
      get bindingEpoch() { return store.getCardThreadEpoch(openId, deviceId, 'schedule'); },
      switchDevices: async () => {
        const binding = store.getUserBinding(openId)!;
        const devices = [...binding.devices, { ...binding.devices[0], deviceId: 'second-device', isActive: false }];
        const firstEpoch = store.getCardThreadEpoch(openId, deviceId);
        await store.setUserBinding(openId, { ...binding, activeDeviceId: 'second-device', devices });
        await store.setUserBinding(openId, { ...binding, devices });
        expect(store.getCardThreadEpoch(openId, deviceId)).not.toBe(firstEpoch);
      },
      droppedAcks, resultAttempts, dropScheduleAcks: (drop: boolean) => { loseScheduleAcks = drop; },
      rebind: async () => { await store.deleteUserBinding(openId); await bind(otherOwner); },
      get ws() { return client!; },
      holdReply: () => (replyGate = latch()),
      replaceSelection: (replacement: string) => writeFile(selection(thread.id), replacement),
      snapshot: async () => readFile(await catalogPath()),
      restart: async (snapshot?: Buffer) => {
        await stopCli();
        if (snapshot) await writeFile(await catalogPath(), snapshot);
        await startCli(true);
      },
    };
  } catch (error) { await close(); throw error; }
}

describe('Host-timed scheduled turns over the local Router', () => {
  let root: string;
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'host-scheduled-turns-')));
    vi.stubEnv('HOME', root);
    vi.stubEnv('USERPROFILE', root);
    vi.spyOn(os, 'homedir').mockReturnValue(root);
    vi.clearAllMocks();
    // Socket and filesystem I/O stay real while the schedule clock crosses due minutes.
    vi.useFakeTimers({ now: hour + 5000, shouldAdvanceTime: true,
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  });
  afterEach(async () => {
    try { await f?.close(); } finally {
      f = undefined;
      vi.useRealTimers();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });
  async function advanceTo(timestamp: number) {
    const remaining = timestamp - Date.now();
    expect(remaining).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(remaining);
  }

  it('withholds the wire ACK until Feishu accepts the final result card', async () => {
    const h = f = await fixture(root, 'claude');
    const delivery = new ScheduleDeliveryClient(h.ws);
    const pending = latch();
    h.feishu.finalizeStreamingMessage.mockImplementationOnce(async () => { await pending.promise; return true; });
    const id = 'fixture-delivery';
    const sent = delivery.deliver({ id, occurrenceId: 'fixture-occurrence', success: true, output: 'Receipt control',
      schedule: { id: 'fixture-schedule', openId, threadId: h.thread.id, backend: 'claude', generation: 'fixture',
        engine: 'host', bindingEpoch: h.bindingEpoch,
        createdAt: hour, state: 'completed', cwd: root, prompt: task, rule: { kind: 'once', at: new Date(hour).toISOString() } },
    }, threadName);
    try {
      await vi.waitFor(() => expect(h.feishu.finalizeStreamingMessage).toHaveBeenCalledOnce(), wait);
      expect(h.acks).not.toContain(id);
      pending.release();
      await sent;
      expect(await h.receipt(0, 'fixture-schedule', 'Receipt control')).toBe(id);
    } finally {
      pending.release();
      delivery.destroy();
      await sent.catch(() => {});
    }
  });

  describe.each(backends)('%s', backend => {
    it('accepts a natural-language reminder through the managed tool and delivers its one-shot after restart', async () => {
      const h = f = await fixture(root, backend);
      await h.command(reminder);
      expect(h.managedCreates, h.managedCreates[0]?.error).toMatchObject([{ status: 'succeeded', scheduleId: expect.any(String) }]);
      const id = h.managedCreates[0].scheduleId!;
      expect((await h.catalog()).records).toMatchObject([{ id, engine: 'host', prompt: task, backend, openId, sessionId: h.sessionId }]);
      expect(h.turns).toHaveLength(1);
      expect(h.turns[0].prompt).toContain(reminder);
      await h.restart();
      expect((await h.command('/schedule list')).output).toContain(id);
      expect(h.turns).toHaveLength(1);
      await advanceTo(hour + minute);
      await h.receipt(0, id, 'Provider reply 2');
      h.expectTurn(1, hour + minute);
      expect(h.turns).toHaveLength(2);
      expect(h.nativeCreate).not.toHaveBeenCalled();
      expect(h.nativeManagement).not.toHaveBeenCalled();
    });

    it('hides the original schedule from the rebound user and refuses cancellation and due execution', async () => {
      const h = f = await fixture(root, backend);
      const id = await h.create('at 2030-01-07T08:01:00Z');
      await h.rebind();
      await h.restart();
      const listed = await h.request('/schedule list', otherOwner);
      expect(JSON.stringify(listed)).not.toContain(id);
      expect(JSON.stringify(listed)).not.toContain(task);
      expect((await h.request(`/schedule cancel ${id}`, otherOwner)).success).toBe(false);
      await advanceTo(hour + minute);
      await vi.waitFor(async () => expect((await h.catalog()).records.find(record => record.id === id)?.state)
        .toMatch(/^(failed|interrupted|cancelled|completed)$/), wait);
      expect(h.turns).toHaveLength(0);
      expect(h.acks.filter(ack => ack.startsWith(id + ':'))).toEqual([]);
      expect(h.feishu.sendStreamingStart.mock.calls.filter(([, intro]) => intro?.includes('Scheduled task result'))).toEqual([]);
      expect(h.nativeManagement).not.toHaveBeenCalled();
    });

    it('retries the same result after a lost final ACK without another turn or card', async () => {
      const h = f = await fixture(root, backend);
      const scheduleId = await h.create('at 2030-01-07T08:01:00Z');
      h.dropScheduleAcks(true);
      await advanceTo(hour + minute);
      await vi.waitFor(() => expect(h.droppedAcks.size).toBe(1), wait);
      const [resultId] = h.droppedAcks;
      expect((await h.catalog()).pending).toMatchObject([{ id: resultId, scheduleId }]);
      h.dropScheduleAcks(false);
      await h.switchDevices();
      await h.restart();
      expect(await h.receipt(0, scheduleId, 'Provider reply 1', true)).toBe(resultId);
      await vi.waitFor(async () => expect((await h.catalog()).pending).toEqual([]), wait);
      expect(h.resultAttempts).toEqual([resultId, resultId]);
      expect(h.turns).toHaveLength(1);
      expect(h.nativeManagement).not.toHaveBeenCalled();
    });

    it('reports an unknown outcome from the durable in-flight record without replaying the turn', async () => {
      const h = f = await fixture(root, backend);
      const scheduleId = await h.create('at 2030-01-07T08:01:00Z');
      const reply = h.holdReply();
      await advanceTo(hour + minute);
      await vi.waitFor(() => expect(h.turns).toHaveLength(1), wait);
      const snapshot = await h.snapshot();
      expect(JSON.parse(snapshot.toString()).records).toMatchObject([{ id: scheduleId, state: 'running', inFlightDueAt: hour + minute }]);
      h.ws.disconnect();
      reply.release();
      await vi.waitFor(async () => expect((await h.catalog()).pending).toHaveLength(1), wait);
      await h.restart(snapshot);
      const id = `${scheduleId}:host-${hour + minute}`;
      await vi.waitFor(() => expect(h.acks).toContain(id), wait);
      await h.settleDelivery();
      await vi.waitFor(async () => expect(await h.catalog()).toMatchObject({
        pending: [], records: [{ id: scheduleId, state: 'failed', error: expect.stringContaining('unknown') }],
      }), wait);
      const finals = h.feishu.finalizeStreamingMessage.mock.calls.filter(([card]) => card === `card-${id}`);
      expect(finals).toHaveLength(1);
      expect([finals[0][3], finals[0][7]]).toEqual([openId, h.thread.id]);
      expect(JSON.stringify(finals[0][1])).toContain('unknown');
      expect(h.turns).toHaveLength(1);
      expect(h.nativeManagement).not.toHaveBeenCalled();
    });

    it('runs a one-shot in its original session after clean service restart before due', async () => {
      const h = f = await fixture(root, backend);
      const id = await h.create('at 2030-01-07T08:01:00Z');
      await h.switchDevices();
      await h.restart();
      await advanceTo(hour + 45_000);
      expect(h.turns).toHaveLength(0);
      await advanceTo(hour + minute);
      await h.receipt(0, id, 'Provider reply 1');
      h.expectTurn(0, hour + minute);
      await vi.waitFor(async () => expect(await h.catalog()).toMatchObject({ records: [{ id, state: 'completed' }], pending: [] }), wait);
      await advanceTo(hour + 3 * minute);
      await h.restart();
      expect(h.turns).toHaveLength(1);
    });

    it('fires twice at matching cron minutes and cancels before the third', async () => {
      const h = f = await fixture(root, backend);
      const id = await h.create('cron "1,3,5 17 * * *" --tz Asia/Tokyo');
      await advanceTo(hour + minute);
      const first = await h.receipt(0, id, 'Provider reply 1');
      await advanceTo(hour + 2 * minute);
      expect(h.turns).toHaveLength(1);
      await advanceTo(hour + 3 * minute);
      const second = await h.receipt(1, id, 'Provider reply 2');
      expect(first).not.toBe(second);
      h.expectTurn(0, hour + minute);
      h.expectTurn(1, hour + 3 * minute);
      await vi.waitFor(async () => expect((await h.catalog()).pending).toEqual([]), wait);
      await h.command(`/schedule cancel ${id}`);
      await advanceTo(hour + 6 * minute);
      await h.command('/schedule list');
      expect((await h.catalog()).records).toMatchObject([{ id, state: 'cancelled' }]);
      await h.restart();
      expect(h.turns).toHaveLength(2);
      expect(h.nativeManagement).not.toHaveBeenCalled();
      expect(h.feishu.sendStreamingStart.mock.calls.filter(([, intro]) => intro?.includes('Scheduled task result'))).toHaveLength(2);
    });

    it('retries an offline final result from the durable outbox without another execution', async () => {
      const h = f = await fixture(root, backend);
      const id = await h.create('at 2030-01-07T08:01:00Z');
      const reply = h.holdReply();
      await advanceTo(hour + minute);
      await vi.waitFor(() => expect(h.turns).toHaveLength(1), wait);
      h.ws.disconnect();
      reply.release();
      await vi.waitFor(async () => expect((await h.catalog()).pending)
        .toMatchObject([{ scheduleId: id, output: 'Provider reply 1' }]), wait);
      const [outbox] = (await h.catalog()).pending;
      expect(h.acks).not.toContain(outbox.id);
      await h.restart();
      expect(await h.receipt(0, id, 'Provider reply 1')).toBe(outbox.id);
      await vi.waitFor(async () => expect((await h.catalog()).pending).toEqual([]), wait);
      h.expectTurn(0, hour + minute);
      expect(h.turns).toHaveLength(1);
    });

    it('refuses dispatch when the provider reopens a different native session', async () => {
      const h = f = await fixture(root, backend);
      const id = await h.create('at 2030-01-07T08:01:00Z');
      const replacement = randomUUID();
      await h.replaceSelection(replacement);
      await h.restart();
      await advanceTo(hour + minute);
      await vi.waitFor(async () => expect((await h.catalog()).records).toMatchObject([{ id, state: 'failed' }]), wait);
      await advanceTo(hour + 2 * minute);
      await h.restart();
      expect(h.turns).toHaveLength(0);
    });
  });
});
