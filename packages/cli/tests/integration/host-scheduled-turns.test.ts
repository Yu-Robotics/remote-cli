import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { once } from 'events';
import { readFileSync } from 'fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'fs/promises';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import { isMainThread } from 'worker_threads';
import Koa from 'koa';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RouterServer } from '../../../router/src/server';
import { FeishuLongConnHandler } from '../../../router/src/feishu/FeishuLongConnHandler';
import { JsonStore } from '../../../router/src/storage/JsonStore';
import type { ConfigManager as RouterConfig } from '../../../router/src/config/ConfigManager';
import { DEFAULT_CONFIG } from '../../../router/src/types/config';
import { MessageHandler } from '../../src/client/MessageHandler';
import { WebSocketClient } from '../../src/client/WebSocketClient';
import { ConfigManager } from '../../src/config/ConfigManager';
import { DelegationManager } from '../../src/delegation/DelegationManager';
import { ClaudePersistentExecutor } from '../../src/executor/ClaudePersistentExecutor';
import * as managedSpawn from '../../src/executor/ManagedSpawn';
import { CodexAppServerExecutor, type CodexAppServerTransport } from '../../src/executor/CodexAppServerExecutor';
import type { AppServerMessage } from '../../src/executor/CodexAppServerClient';
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
const followUp = 'Please report on this conversation now.';

function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function fixture(root: string, backend: Backend, executorFactory?: ExecutorFactory) {
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
  feishu.finalizeStreamingMessage.mockImplementation(async (cardId, ...args) => {
    const confirmation = args[7], options = args[10];
    if (confirmation) await options?.onDelivered?.([cardId], cardId);
    return true;
  });
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
          const output = `Provider reply ${number}`;
          if (options?.hostScheduleSessionId === undefined) {
            options?.onStream?.(output);
            options?.onDisplayText?.(output);
          }
          return { success: true, output };
        },
        withNativeScheduleOperation: async (_id, current, run) => {
          nativeManagement();
          if (!current()) throw new Error('Stale native operation');
          return run();
        },
        createNativeSchedule: nativeCreate,
        resetContext: vi.fn(), isBusy: () => false, setWorkingDirectory: vi.fn(),
        abort: async () => { replyGate?.release(); return true; },
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
    async function startCli(reloadCatalog = false, expectedCatalogError?: string) {
      initialization.mockClear();
      const config = await ConfigManager.initialize();
      const manager = await ThreadManager.initialize(root);
      const pool = new ThreadExecutorPool(manager, guard, config.get('executor'), executorFactory ?? factory);
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
      const load = current['loadScheduleCatalog'].bind(current);
      let reconciliation: Promise<void> | undefined;
      vi.spyOn(current as unknown as { loadScheduleCatalog(): Promise<void> }, 'loadScheduleCatalog')
        .mockImplementation(() => reconciliation = load());
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
        // Registration starts reconciliation without delaying ordinary messages.
        // Join that pass so the timer is armed before advancing the test clock.
        expect(reconciliation).toBeDefined();
        if (expectedCatalogError) await expect(reconciliation).rejects.toThrow(expectedCatalogError);
        else await reconciliation;
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
    async function snapshot() {
      const service = initialization.mock.instances.at(-1)!;
      return service['serial'](async () => readFile(await catalogPath()));
    }
    async function catalog() {
      return JSON.parse((await snapshot()).toString('utf8')) as {
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
    async function sendText(text: string, parentCard?: string) {
      // Feed the real Feishu text receiver; card API calls stay local to the fixture.
      const actual = await vi.importActual<typeof import('../../../router/src/feishu/FeishuLongConnHandler')>(
        '../../../router/src/feishu/FeishuLongConnHandler');
      const receiver = new actual.FeishuLongConnHandler({ appId: 'fixture', appSecret: 'fixture', store });
      receiver.setConnectionHub(hub);
      receiver.setOnStartStreaming(feishu.setOnStartStreaming.mock.calls[0][0]);
      receiver.setOnResolveThread(feishu.setOnResolveThread.mock.calls[0][0]);
      receiver.setOnResolveActiveThread(feishu.setOnResolveActiveThread.mock.calls[0][0]);
      receiver.setOnCaptureSelection(feishu.setOnCaptureSelection.mock.calls[0][0]);
      receiver.setOnValidateSelection(feishu.setOnValidateSelection.mock.calls[0][0]);
      const start = vi.spyOn(receiver, 'sendStreamingStart').mockImplementation(feishu.sendStreamingStart);
      const rejected = vi.spyOn(receiver as unknown as { replyToMessage(id: string, text: string): Promise<void> },
        'replyToMessage').mockResolvedValue();
      await receiver['handleMessageEvent']({ sender: { sender_id: { open_id: openId } }, message: {
        message_type: 'text', message_id: randomUUID(), parent_id: parentCard, content: JSON.stringify({ text }),
      } });
      expect(rejected).not.toHaveBeenCalled();
      expect(start).toHaveBeenCalledOnce();
      return { receiver, messageId: start.mock.calls[0][4]! };
    }
    async function sendFollowUp(parentCard?: string) {
      const { messageId } = await sendText(followUp, parentCard);
      const finals = () => feishu.finalizeStreamingMessage.mock.calls.filter(([card]) => card === `card-${messageId}`);
      await vi.waitFor(() => expect(finals()).toHaveLength(1), wait);
      const [final] = finals();
      expect([final[3], final[7], final[10]]).toEqual([openId, thread.id, true]);
      expect(responses.get(messageId)).toMatchObject({ success: true });
      expect(resultAttempts).not.toContain(messageId);
      return JSON.stringify(final[1]);
    }
    return { create, command, request, catalog, receipt, settleDelivery, expectTurn, turns, acks, checked, sessionId, thread, feishu, close, sendFollowUp, sendText,
      cardRoute: (cardId: string) => store.getCardThread(cardId),
      selectThread: () => store.setDeviceThreadSelection(openId, deviceId, thread.id),
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
      snapshot,
      restart: async (snapshot?: Buffer, expectedCatalogError?: string) => {
        await stopCli();
        if (snapshot) await writeFile(await catalogPath(), snapshot);
        await startCli(true, expectedCatalogError);
      },
    };
  } catch (error) { await close(); throw error; }
}

async function setupHome() {
  // Restart cases release and reacquire the native schedule catalog lock.
  expect(isMainThread).toBe(true);
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'host-scheduled-turns-')));
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  vi.stubEnv('CODEX_HOME', path.join(root, '.codex'));
  vi.spyOn(os, 'homedir').mockReturnValue(root);
  vi.clearAllMocks();
  // Socket and filesystem I/O stay real while the schedule clock crosses due minutes.
  vi.useFakeTimers({ now: hour + 5000, shouldAdvanceTime: true,
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  return root;
}

async function cleanup(root: string, f?: Awaited<ReturnType<typeof fixture>>) {
  try { await f?.close(); } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
}

async function advanceTo(timestamp: number) {
  const remaining = timestamp - Date.now();
  expect(remaining).toBeGreaterThan(0);
  await vi.advanceTimersByTimeAsync(remaining);
}

describe('Host-timed scheduled turns over the local Router', () => {
  let root: string;
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  beforeEach(async () => { f = undefined; root = await setupHome(); });
  afterEach(async () => { await cleanup(root, f); });

  it.each(['close', 'spared'])('resumes confirmed Feishu chat once after a host-timed Claude abort (%s)', async mode => {
    // The real executor either closes its child or joins a retained native foreground.
    const launches: ChildProcess[] = [];
    const prompts = path.join(root, 'prompts.jsonl');
    await writeFile(prompts, '');
    const submissions = async () => (await readFile(prompts, 'utf8')).trim().split('\n')
      .filter(Boolean).map(line => JSON.parse(line) as { session: string; pid: number; text: string });
    const script = String.raw`
      const [mode, log, ...args] = process.argv.slice(1);
      const session = args[args.indexOf('--resume') + 1];
      const send = frame => console.log(JSON.stringify(frame));
      let first = true;
      require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const frame = JSON.parse(line);
        if (frame.type === 'control_request') {
          let response;
          switch (frame.request.subtype) {
            case 'initialize': response = { models: [], pid: process.pid, claude_code_version: '2.1.327' }; break;
            case 'get_settings': response = { effective: {} }; break;
            case 'interrupt': {
              const [id] = frame.request.for_user_message_uuids;
              require('node:fs').writeFileSync(log + '.spared', JSON.stringify({ session, pid: process.pid }));
              send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id,
                response: { turn: 'spared', still_queued: [] } } });
              send({ type: 'result', is_error: false, result: 'Natural completion', session_id: session, user_message_uuid: id });
              send({ type: 'command_lifecycle', command_uuid: id, state: 'completed', session_id: session });
              return;
            }
            default: throw new Error('Unexpected control request: ' + frame.request.subtype);
          }
          send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response } });
        } else if (frame.type === 'user') {
          const text = frame.message.content;
          require('node:fs').appendFileSync(log, JSON.stringify({ session, pid: process.pid, text }) + '\n');
          send({ type: 'system', subtype: 'init', session_id: session, capabilities: mode === 'spared'
            ? ['interrupt_receipt_v1', 'msg_lifecycle_v1', 'lifecycle_wakeup_source_v1'] : [] });
          send({ type: 'command_lifecycle', command_uuid: frame.uuid, state: 'started', session_id: session });
          if (first && mode !== 'answer') { first = false; return; }
          const answer = 'Fixture answered: ' + text;
          send({ type: 'assistant', message: { content: [{ type: 'text', text: answer }] } });
          send({ type: 'result', is_error: false, result: answer, session_id: session, user_message_uuid: frame.uuid });
          send({ type: 'command_lifecycle', command_uuid: frame.uuid, state: 'completed', session_id: session });
        }
      });
    `;
    vi.spyOn(managedSpawn, 'spawnManaged').mockImplementation((_worker, command, args, options) => {
      expect(command).toBe('fixture-claude');
      expect(args).toContain('--resume');
      const child = spawn(process.execPath, ['-e', script, '--', launches.length ? 'answer' : mode, prompts, ...args],
        { cwd: options.cwd, env: { HOME: root, USERPROFILE: root }, stdio: 'pipe' });
      launches.push(child);
      return child;
    });
    const h = f = await fixture(root, 'claude', (guard, _effective, cwd, id) =>
      new ClaudePersistentExecutor(guard, cwd, id, undefined, undefined, 'fixture-claude', false));
    const directory = path.join(root, '.remote-cli', 'claude-sessions');
    await mkdir(directory, { recursive: true });
    const pointer = path.join(directory, h.thread.id + '.json');
    await writeFile(pointer, JSON.stringify({ id: h.sessionId }));
    expect(await h.selectThread()).toBe(true);
    const recurring = await h.create('cron "1,3 8 * * *" --tz UTC');
    const occurrence = `${recurring}:host-${hour + minute}`;
    await advanceTo(hour + minute);
    await vi.waitFor(async () => expect(await submissions()).toMatchObject([{ session: h.sessionId, text: task }]), wait);

    const { receiver, messageId } = await h.sendText(followUp);
    const finals = () => h.feishu.finalizeStreamingMessage.mock.calls;
    const confirmation = await vi.waitFor(() => {
      const info = finals().find(([card]) => card === `card-${messageId}`)?.[8];
      expect(info).toMatchObject({ threadId: h.thread.id, backend: 'claude' });
      return info!;
    }, wait);
    // Send the production queue-card confirmation, including its fresh execution message ID.
    const registerExecution = vi.fn(h.feishu.setOnStartStreaming.mock.calls[0][0]);
    receiver.setOnStartStreaming(registerExecution);
    const cardId = `card-${messageId}`;
    await vi.waitFor(() => expect(h.cardRoute(cardId)).toMatchObject({ queueId: confirmation.id }), wait);
    const patch = vi.spyOn(receiver['client'].im.message, 'patch').mockResolvedValue({ code: 0 });
    expect(await receiver.sendQueueActionFromCardAction(openId, 'confirm', confirmation.id, h.thread.id, cardId)).toBe('sent');
    expect(patch).toHaveBeenCalledWith(expect.objectContaining({ path: { message_id: cardId } }));
    expect(registerExecution).toHaveBeenCalledOnce();
    const executionId = registerExecution.mock.calls[0][0];
    await vi.waitFor(async () => {
      const queue = (await h.command('/queue')).output;
      expect(queue).toContain('Confirmed: 1; awaiting confirmation: 0');
      expect(queue).toContain(followUp);
    }, wait);
    expect(await submissions()).toHaveLength(1);
    expect(launches[0].exitCode).toBeNull();

    const abort = await h.sendText('/abort');
    await vi.waitFor(() => {
      const card = finals().find(([id]) => id === `card-${abort.messageId}`);
      expect(card?.[10]).toBe(true);
      expect(JSON.stringify(card?.[1])).toContain(mode === 'close' ? 'scheduled occurrence was interrupted' : 'native outcome is unconfirmed');
    }, wait);
    if (mode === 'close') expect(launches[0].exitCode).toBe(0);
    else expect(JSON.parse(await readFile(prompts + '.spared', 'utf8'))).toEqual({ session: h.sessionId, pid: launches[0].pid });
    await vi.waitFor(() => expect(h.acks).toContain(occurrence), wait);
    expect(JSON.stringify(finals().find(([id]) => id === `card-${occurrence}`)?.[1]))
      .toContain(mode === 'close' ? 'interrupted by /abort' : 'native outcome is unconfirmed');
    await vi.waitFor(() => {
      const replies = finals().filter(([card]) => card === `card-${executionId}`);
      expect(replies).toHaveLength(1);
      expect([replies[0][3], replies[0][7], replies[0][10]]).toEqual([openId, h.thread.id, true]);
      expect(JSON.stringify(replies[0][1])).toContain('Fixture answered: ');
      expect(JSON.stringify(replies[0][1])).toContain(followUp);
    }, wait);
    await advanceTo(hour + 3 * minute);
    await h.receipt(1, recurring, 'Fixture answered: ' + task);
    if (mode === 'close') expect(launches).toHaveLength(2);
    expect(await submissions()).toEqual([
      { session: h.sessionId, pid: launches[0].pid, text: task },
      { session: h.sessionId, pid: launches.at(-1)!.pid, text: expect.stringContaining(followUp) },
      { session: h.sessionId, pid: launches.at(-1)!.pid, text: task },
    ]);
    expect(JSON.parse(await readFile(pointer, 'utf8')).id).toBe(h.sessionId);
  }, 15_000);

  it('preserves a naturally completed occurrence when executor abort also returns true', async () => {
    const h = f = await fixture(root, 'claude');
    const recurring = await h.create('cron "1,3 8 * * *" --tz UTC');
    const sibling = await h.create('at 2030-01-07T08:02:00Z');
    h.holdReply();
    await advanceTo(hour + minute);
    await vi.waitFor(() => expect(h.turns).toHaveLength(1), wait);
    expect((await h.request('/abort', otherOwner)).success).toBe(false);
    const abort = await h.request('/abort');
    await h.receipt(0, recurring, 'Provider reply 1');
    expect(abort).toMatchObject({ success: false, error: expect.stringContaining('not interrupted') });
    await advanceTo(hour + 2 * minute);
    await h.receipt(1, sibling, 'Provider reply 2');
    await advanceTo(hour + 3 * minute);
    await h.receipt(2, recurring, 'Provider reply 3');
    expect(h.turns).toHaveLength(3);
  });

  it('stops just the admitted cron occurrence when /abort arrives during the workspace check', async () => {
    const h = f = await fixture(root, 'claude');
    const recurring = await h.create('cron "1,3 8 * * *" --tz UTC');
    const gate = latch();
    const original = DelegationManager.prototype.assertExecutionSafe;
    const safety = vi.spyOn(DelegationManager.prototype, 'assertExecutionSafe');
    safety.mockImplementationOnce(async function (this: DelegationManager, cwd, threadId) {
      await gate.promise;
      await original.call(this, cwd, threadId);
    });
    await advanceTo(hour + minute);
    let stopping;
    try {
      await vi.waitFor(() => expect(safety).toHaveBeenCalledWith(root, h.thread.id), wait);
      expect((await h.request('/abort', otherOwner)).success).toBe(false);
      stopping = h.request('/abort');
      // The later command on this socket establishes that /abort has reached the handler.
      await h.command('/queue');
    } finally { gate.release(); }
    const abort = await stopping;
    const occurrence = `${recurring}:host-${hour + minute}`;
    await vi.waitFor(() => expect(h.acks).toContain(occurrence), wait);
    expect(h.turns).toHaveLength(0);
    expect(abort).toMatchObject({ success: true, output: expect.stringContaining('before dispatch') });
    const final = h.feishu.finalizeStreamingMessage.mock.calls.find(([card]) => card === `card-${occurrence}`)!;
    expect([final[3], final[7], final[10]]).toEqual([openId, h.thread.id, false]);
    expect(JSON.stringify(final[1])).toContain('before dispatch');
    await advanceTo(hour + 3 * minute);
    await h.receipt(1, recurring, 'Provider reply 1');
    expect(h.turns).toHaveLength(1);
  });

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

  it('delivers ordinary Feishu text in the selected thread after a corrupt host catalog fails startup', async () => {
    const h = f = await fixture(root, 'claude');
    await h.create('at 2030-01-07T08:01:00Z');
    expect(await h.selectThread()).toBe(true);
    const corrupt = Buffer.from('{"version":7,"records":null,"pending":[]}');
    await h.restart(corrupt, 'Invalid schedule catalog envelope');
    expect(await h.request('/schedule list')).toMatchObject({ success: false, error: expect.stringContaining('Invalid schedule catalog envelope') });
    await advanceTo(hour + minute);
    expect(await h.sendFollowUp()).toContain('Provider reply 1');
    expect(h.turns).toMatchObject([{ prompt: expect.stringContaining(followUp), threadId: h.thread.id, sessionId: h.sessionId }]);
    expect(await h.snapshot()).toEqual(corrupt);
    expect(h.resultAttempts).toEqual([]);
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

    it('reports an unknown outcome and delivers the next Feishu reply without replaying the turn', async () => {
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
      expect(await h.sendFollowUp(`card-${id}`)).toContain('Provider reply 2');
      expect(h.turns).toMatchObject([
        { prompt: task, sessionId: h.sessionId },
        { prompt: expect.stringContaining(followUp), sessionId: h.sessionId, threadId: h.thread.id, backend },
      ]);
      expect(h.resultAttempts).toEqual([id]);
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
      await vi.waitFor(() => expect(h.acks).toContain(`${id}:host-${hour + minute}`), wait);
      await h.settleDelivery();
      await vi.waitFor(async () => expect((await h.catalog()).records).toMatchObject([{ id, state: 'failed' }]), wait);
      await advanceTo(hour + 2 * minute);
      await h.restart();
      expect(h.turns).toHaveLength(0);
      expect(await h.sendFollowUp(`card-${id}:host-${hour + minute}`)).toContain('Provider reply 1');
      expect(h.turns).toMatchObject([{ prompt: expect.stringContaining(followUp), sessionId: replacement, threadId: h.thread.id, backend }]);
      expect(h.resultAttempts).toEqual([`${id}:host-${hour + minute}`]);
    });
  });
});

describe('Feishu recovery after Codex rejects a scheduled turn', () => {
  let streamedCard: string;
  let completedItemCard: string;
  const streamedAnswer = 'The original Codex thread is available.';
  const completedAnswer = 'This reply arrived as a completed item.';

  // Finish and verify all I/O before the card-content assertions. A setup,
  // routing, or executor failure must fail the suite in its own right.
  beforeAll(async () => {
    const root = await setupHome();
    let h: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      const submissions: { threadId: string; text: string; pinned: boolean }[] = [];
      const factory: ExecutorFactory = (guard, effective, cwd, id) => {
        expect(effective.type).toBe('codex');
        let running = false;
        let emit!: (message: AppServerMessage) => void;
        const transport: CodexAppServerTransport = {
          start: async () => { running = true; }, stop: async () => { running = false; },
          isRunning: () => running, setWorkingDirectory: vi.fn(), respond: vi.fn(), respondError: vi.fn(),
          onMessage: handler => { emit = handler; return () => {}; },
          request: async (method, params, _timeout, requireRunning) => {
            if (method === 'thread/resume') return { thread: { id: params.threadId } };
            if (method !== 'turn/start') throw new Error(`Unexpected fixture RPC: ${method}`);
            submissions.push({ threadId: params.threadId, text: params.input[0].text, pinned: requireRunning === true });
            if (requireRunning) throw new Error('Synthetic scheduled turn rejection');
            const turnId = `turn-${submissions.length}`;
            const streamed = submissions.length === 2;
            const answer = streamed ? streamedAnswer : completedAnswer;
            setImmediate(() => {
              const ids = { threadId: params.threadId, turnId };
              if (streamed) emit({ method: 'item/agentMessage/delta', params: { ...ids, itemId: 'answer', delta: answer } });
              emit({ method: 'item/completed', params: { ...ids, item: { id: 'answer', type: 'agentMessage', text: answer } } });
              emit({ method: 'turn/completed', params: { ...ids, turn: { id: turnId, status: 'completed' } } });
            });
            return { turn: { id: turnId } };
          },
        };
        return new CodexAppServerExecutor(guard, { initialWorkingDirectory: cwd, threadId: id, clientFactory: () => transport });
      };
      h = await fixture(root, 'codex', factory);
      const sessionDirectory = path.join(root, '.remote-cli', 'codex-sessions');
      await mkdir(sessionDirectory, { recursive: true });
      await writeFile(path.join(sessionDirectory, h.thread.id + '.json'), JSON.stringify({ id: h.sessionId }));
      const id = await h.create('at 2030-01-07T08:01:00Z');
      const occurrence = `${id}:host-${hour + minute}`;
      await advanceTo(hour + minute);
      const active = h;
      await vi.waitFor(() => expect(active.acks).toContain(occurrence), wait);
      await h.settleDelivery();
      expect(await h.catalog()).toMatchObject({ records: [{ id, state: 'failed' }], pending: [] });
      const failure = h.feishu.finalizeStreamingMessage.mock.calls.filter(([card]) => card === `card-${occurrence}`);
      expect(failure).toHaveLength(1);
      expect([failure[0][3], failure[0][7], failure[0][10]]).toEqual([openId, h.thread.id, false]);
      expect(JSON.stringify(failure[0][1])).toContain('Synthetic scheduled turn rejection');
      streamedCard = await h.sendFollowUp(`card-${occurrence}`);
      completedItemCard = await h.sendFollowUp(`card-${occurrence}`);
      const ordinary = { threadId: h.sessionId, text: expect.stringContaining(followUp), pinned: false };
      expect(submissions).toEqual([{ threadId: h.sessionId, text: task, pinned: true }, ordinary, ordinary]);
      expect(h.resultAttempts).toEqual([occurrence]);
    } finally { await cleanup(root, h); }
  });

  it('delivers a streamed recovery answer once', () => {
    expect(streamedCard.split(streamedAnswer)).toHaveLength(2);
    expect(completedItemCard).not.toContain(streamedAnswer);
  });

  it('delivers a completed assistant item once when no text delta precedes it', () => {
    expect(completedItemCard.split(completedAnswer)).toHaveLength(2);
  });
});
