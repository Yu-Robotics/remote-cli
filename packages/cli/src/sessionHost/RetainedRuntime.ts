import { createHash, randomUUID } from 'crypto';
import fs from 'fs/promises';
import type { ThreadManager } from '../thread/ThreadManager';
import type { ThreadExecutorPool } from '../thread/ThreadExecutorPool';
import type { DirectoryGuard } from '../security/DirectoryGuard';
import type { WebSocketClient } from '../client/WebSocketClient';
import type { ExecutorConfig } from '../types/config';
import type { IExecutor } from '../executor/IExecutor';
import { ScheduleService } from '../scheduling/ScheduleService';
import { ScheduleDeliveryClient } from '../scheduling/ScheduleDeliveryClient';
import { ScheduleToolOperations, type ScheduleOperation } from '../scheduling/ScheduleToolScope';
import { validateSchedulePrompt, validateScheduleRule } from '../scheduling/ScheduleCommand';
import { assertNativeScheduleBackend } from '../scheduling/ScheduleCapabilities';
import type { NativeScheduleEvent, ScheduleRecord } from '../scheduling/types';
import { ManagedToolBridge } from '../managed/ManagedToolBridge';
import { ClaudeSandbox } from '../executor/claude/ClaudeSandbox';
import { RuntimeJournal, type RuntimeBinding, type RuntimeCommand } from './RuntimeJournal';
import { canonical, fields, object, type HostRuntime, type Json } from './HostProtocol';

export interface RetainedRuntimeOptions {
  directory: string; runtimeVersion: string; config: ExecutorConfig;
  threads: ThreadManager; pool: ThreadExecutorPool; guard: DirectoryGuard; router: WebSocketClient;
}
/** Native authority only. Command parsing/version selection lives in the new frontend. */
export class RetainedRuntime implements HostRuntime {
  readonly authorityId = randomUUID();
  readonly journal: RuntimeJournal;
  private readonly schedules: ScheduleService;
  private readonly delivery: ScheduleDeliveryClient;
  private readonly bridges = new Map<string, ManagedToolBridge>();
  private readonly tools = new ScheduleToolOperations();
  private readonly busy = new Set<string>();
  private readonly toolTurns = new Map<string, { id: string; foreground: boolean; occurrences: Set<string> }>();
  private readonly foregroundToolTurns = new Map<string, string>();
  private eventTail: Promise<void> = Promise.resolve();
  private ready = false;
  private closed = false;
  private stopping = false;
  private stopWork?: Promise<void>;
  private nativeHostsJoined = false;
  private routerVersion?: string;
  private frontendVersion?: string;
  private readonly unsubscribe: () => void;
  private retryTimer?: NodeJS.Timeout;
  private retrying?: Promise<void>;

  constructor(private readonly options: RetainedRuntimeOptions) {
    this.journal = new RuntimeJournal(options.directory, this.authorityId);
    this.delivery = new ScheduleDeliveryClient(options.router);
    this.schedules = new ScheduleService({ directory: options.directory,
      deferDelivery: true,
      isOwnerCurrent: owner => this.current(owner as RuntimeBinding),
      isNativeMutationPending: owner => options.pool.getExistingExecutor(owner.threadId)?.hasPendingScheduleMutation?.() ?? false,
      provider: { create: (input, onEvent, canAdmit) => {
        const binding = this.binding(input.threadId!);
        const executor = options.pool.getExecutor(binding.threadId);
        if (!executor.createNativeSchedule) throw new Error('Native scheduling capability is unavailable.');
        return executor.createNativeSchedule(input, event => {
          // Synchronous durable acceptance precedes every adapter callback return,
          // including adapters that do not await the returned Promise.
          const id = randomUUID();
          try { this.journal.change(state => state.nativeEvents.push({ id, scheduleId: input.id, event })); }
          catch (error) { this.journal.healthy = false; throw error; }
          if (event.type === 'started') {
            let turn = this.toolTurns.get(binding.threadId);
            if (!turn) {
              turn = { id: `native-${randomUUID()}`, foreground: false, occurrences: new Set() };
              this.toolTurns.set(binding.threadId, turn);
            }
            turn.occurrences.add(`${input.id}:${event.occurrenceId}`);
          }
          if (event.type === 'completed') {
            // Native terminal receipt, rather than delayed outbox processing,
            // closes this tool turn. Non-awaiting adapters can start the next
            // invocation before the earlier catalog write has finished.
            const turn = this.toolTurns.get(binding.threadId);
            turn?.occurrences.delete(`${input.id}:${event.occurrenceId}`);
            if (turn && !turn.foreground && !turn.occurrences.size) this.toolTurns.delete(binding.threadId);
          }
          const settled = this.eventTail.then(async () => {
            await onEvent(event);
            this.journal.change(state => { state.nativeEvents = state.nativeEvents.filter(entry => entry.id !== id); });
          });
          this.eventTail = settled.catch(() => { this.journal.healthy = false; });
          return settled;
        }, () => this.current(binding), () => !this.stopping && this.current(binding) && this.journal.snapshot().nativeEvents.length < 480 && (canAdmit?.() ?? true));
      } },
      deliver: async result => {
        if (!this.ready) throw new Error('Router scheduled delivery is unavailable.');
        await this.delivery.deliver(result, this.binding(result.schedule.threadId).name);
      },
    });
    this.unsubscribe = options.router.onTaskResultAck(id => {
      const command = this.journal.snapshot().commands.find(row => row.messageId === id);
      if (command?.status !== 'completed') return;
      this.journal.change(state => {
        const row = state.commands.find(entry => entry.messageId === id)!;
        row.status = 'acknowledged'; row.command = ''; delete row.response;
      });
    });
    options.router.onClose(() => { this.ready = false; });
    options.router.onMessage(message => { void this.receive(message).catch(() => {
      // Unaccepted malformed/capacity-limited commands never become native work.
      // Durable IO failures fence admission inside RuntimeJournal itself.
      if (object(message) && message.type === 'command' && typeof message.messageId === 'string' && typeof message.openId === 'string') {
        try { options.router.send({ type: 'response', messageId: message.messageId, openId: message.openId,
          success: false, error: 'Retained command admission failed; no native work was dispatched.', timestamp: Date.now() }); } catch { /* The unaccepted command may be retried by its caller. */ }
      }
    }); });
  }
  async start(): Promise<void> {
    await this.schedules.initialize(); await this.options.router.connect();
    this.retryTimer = setInterval(() => {
      if (!this.ready || this.retrying) return;
      this.flushResponses();
      this.retrying = this.schedules.retryDeliveries().catch(() => {}).finally(() => { this.retrying = undefined; });
    }, 5000);
  }

  private async receive(message: unknown): Promise<void> {
    if (!object(message) || this.closed || this.stopping) return;
    if (message.type === 'status' && typeof message.messageId === 'string' && message.messageId.length <= 256) {
      this.options.router.send({ type: 'status', messageId: message.messageId,
        status: { connected: this.options.router.isConnected(), allowedDirectories: this.options.guard.getAllowedDirectories(),
          threads: this.catalog() }, timestamp: Date.now() });
      return;
    }
    if (message.type === 'binding_confirm' && object(message.data) && message.data.success === true) {
      const capabilities = message.data.capabilities;
      this.ready = object(capabilities) && capabilities.scheduleResultsV1 === true && capabilities.taskRecovery === true;
      this.routerVersion = typeof message.data.routerVersion === 'string' ? message.data.routerVersion : undefined;
      if (this.ready) { void this.schedules.retryDeliveries().catch(() => {}); this.flushResponses(); }
      return;
    }
    if (message.type !== 'command') return;
    const { messageId, openId, threadId } = message;
    const unsupportedAttachments = message.attachments !== undefined && (!Array.isArray(message.attachments) || message.attachments.length > 0);
    const command = message.content ?? (unsupportedAttachments ? '' : undefined);
    if (typeof messageId !== 'string' || !messageId || messageId.length > 256 || typeof openId !== 'string' || !openId || openId.length > 256
      || typeof command !== 'string' || Buffer.byteLength(command) > 16 * 1024 || threadId !== undefined && typeof threadId !== 'string') throw new Error('Invalid retained command.');
    const existing = this.journal.snapshot().commands.find(row => row.messageId === messageId);
    if (existing) {
      if (existing.openId !== openId || existing.threadId !== threadId) throw new Error('Command ownership changed.');
      this.flushResponses(); return;
    }
    this.journal.change(state => state.commands.push({ messageId, openId, ...(threadId ? { threadId } : {}), command, status: 'queued' }));
    if (unsupportedAttachments) this.complete(messageId, { success: false, threadId: threadId as string | undefined,
      error: 'Attachments are not supported by the retained-host command profile. No native work was dispatched.' });
  }

  async inspect(method: string, args: Json): Promise<Json> {
    if (method !== 'state' || args !== null) throw new Error('Unknown runtime inspection.');
    const state = this.journal.snapshot();
    return JSON.parse(JSON.stringify({ runtimeVersion: this.options.runtimeVersion, frontendVersion: this.frontendVersion,
      routerVersion: this.routerVersion, ready: this.ready, healthy: this.journal.healthy,
      // Bound the wire snapshot before JSON escaping; the remaining ingress stays
      // in the host journal and becomes visible after this batch is accepted.
      commands: state.commands.filter(row => row.status === 'queued').slice(0, 16), owners: state.owners }));
  }
  async execute(operation: { requestId: string; method: string; args: Json }): Promise<Json> {
    if (this.closed || this.stopping || !this.journal.healthy) throw new Error('Native owner is unavailable.');
    if (operation.method === 'frontendVersion') {
      if (typeof operation.args !== 'string' || !/^\d+\.\d+\.\d+$/.test(operation.args)) throw new Error('Invalid frontend version.');
      this.frontendVersion = operation.args; return { runtimeVersion: this.options.runtimeVersion, frontendVersion: this.frontendVersion };
    }
    if (operation.method !== 'command') throw new Error('Unknown runtime command.');
    fields(operation.args, ['messageId', 'context', 'intent']);
    const { messageId, context, intent } = operation.args;
    if (typeof messageId !== 'string' || !object(intent) || typeof intent.kind !== 'string') throw new Error('Invalid command intent.');
    const row = this.journal.snapshot().commands.find(command => command.messageId === messageId);
    if (!row) throw new Error('Command was not admitted by the authenticated Router.');
    if (row.status !== 'queued') return { status: row.status };
    this.journal.change(state => { state.commands.find(command => command.messageId === messageId)!.status = 'running'; });
    let threadId = row.threadId;
    try {
      let output: string;
      if (intent.kind === 'reply') {
        fields(intent, ['kind', 'output']); if (typeof intent.output !== 'string') throw new Error('Invalid frontend response.'); output = intent.output;
      } else if (intent.kind === 'reject') {
        fields(intent, ['kind', 'error']); if (typeof intent.error !== 'string') throw new Error('Invalid frontend rejection.');
        throw new Error(intent.error);
      } else if (intent.kind === 'newThread') {
        fields(intent, ['kind', 'name', 'cwd', 'backend']);
        if (context !== null || typeof intent.name !== 'string' || typeof intent.cwd !== 'string' || typeof intent.backend !== 'string') throw new Error('Invalid new-thread request.');
        assertNativeScheduleBackend(intent.backend);
        const cwd = await fs.realpath(this.options.guard.resolveWorkingDirectory(intent.cwd));
        this.options.guard.resolveWorkingDirectory(cwd);
        if (this.journal.snapshot().owners.length >= 10) throw new Error('Retained native owner capacity exhausted.');
        const thread = await this.options.threads.createThread(intent.name, cwd, intent.backend);
        const binding: RuntimeBinding = { threadId: thread.id, openId: row.openId, name: thread.name, cwd, backend: intent.backend,
          generation: randomUUID(), contextGeneration: thread.delegationWorkspaceGeneration ?? 0 };
        this.journal.change(state => state.owners.push(binding)); threadId = thread.id;
        output = `Created retained-host thread ${thread.name}. Native state is owned by the runtime host.`;
      } else if (intent.kind === 'select') {
        fields(intent, ['kind']);
        if (!object(context) || typeof context.threadId !== 'string') throw new Error('Missing thread selection.');
        const binding = this.binding(context.threadId);
        if (binding.openId !== row.openId || canonical(context) !== canonical(binding) || !this.current(binding)) throw new Error('Thread selection ownership changed.');
        threadId = binding.threadId; output = `Selected retained-host thread ${binding.name}.`;
      } else {
        const binding = this.resolve(row, context); threadId = binding.threadId;
        if (this.busy.has(threadId) || this.options.pool.isThreadBusy(threadId)) throw new Error('The original native session is busy; no work was dispatched.');
        this.busy.add(threadId);
        try {
          const executor = await this.executor(binding);
          if (intent.kind === 'prompt') {
            fields(intent, ['kind', 'prompt']); validateSchedulePrompt(intent.prompt);
            if (this.toolTurns.has(binding.threadId)) throw new Error('A native occurrence still owns this thread.');
            const turn = `foreground-${row.messageId}`;
            this.foregroundToolTurns.set(binding.threadId, turn);
            let result;
            try { result = await executor.execute(intent.prompt, this.foregroundOptions(row, binding)); }
            finally { if (this.foregroundToolTurns.get(binding.threadId) === turn) this.foregroundToolTurns.delete(binding.threadId); }
            if (!result.success) throw new Error(result.error ?? 'Native foreground execution failed.'); output = result.output ?? '';
          } else if (intent.kind === 'schedule') {
            fields(intent, ['kind', 'operation']);
            output = JSON.stringify(await this.schedule(binding, intent.operation as ScheduleOperation, this.scheduleId(messageId), false));
          } else throw new Error('Unsupported retained-host context operation. Existing sessions were not reset or migrated.');
        } finally { this.busy.delete(threadId); }
      }
      this.complete(messageId, { success: true, output, threadId });
    } catch (error) { this.complete(messageId, { success: false, error: error instanceof Error ? error.message : 'Runtime command failed.', threadId }); }
    return { status: 'completed' };
  }
  private foregroundOptions(row: RuntimeCommand, binding: RuntimeBinding) {
    return { onStream: (text: string) => {
      try { if (this.ready) this.options.router.send({ type: 'stream', messageId: row.messageId, openId: row.openId,
        threadId: binding.threadId, streamType: 'text', chunk: text, timestamp: Date.now() }); } catch { /* Final output remains in the durable outbox. */ }
    } };
  }
  private complete(messageId: string, response: NonNullable<RuntimeCommand['response']>): void {
    const bounded = (text: string | undefined) => text === undefined ? undefined : Buffer.byteLength(text) <= 16 * 1024 ? text : Buffer.from(text).subarray(0, 15 * 1024).toString('utf8') + '\n[Output truncated for delivery.]';
    this.journal.change(state => {
      const row = state.commands.find(command => command.messageId === messageId)!;
      row.status = 'completed'; row.response = { ...response, output: bounded(response.output), error: bounded(response.error) };
    });
    this.flushResponses();
  }
  private flushResponses(): void {
    if (!this.ready || !this.journal.healthy) return;
    for (const row of this.journal.snapshot().commands) if (row.status === 'completed') {
      try { this.options.router.send({ type: 'response', messageId: row.messageId, openId: row.openId, ...row.response,
        threads: this.catalog(row.openId), timestamp: Date.now() }); }
      catch { /* Keep the original output identity until a Router ACK arrives. */ }
    }
  }
  private catalog(openId?: string) {
    const owned = new Set(this.journal.snapshot().owners.filter(owner => !openId || owner.openId === openId).map(owner => owner.threadId));
    // A control-only default satisfies the Router inventory contract without
    // exposing or creating an executor for any pre-feature monolithic session.
    return [{ id: 'retained-host-default', name: 'default', status: 'idle' as const },
      ...this.options.pool.getSummaries().filter(thread => owned.has(thread.id))];
  }
  private binding(id: string): RuntimeBinding {
    const owner = this.journal.snapshot().owners.find(row => row.threadId === id);
    if (!owner) throw new Error('Existing monolithic sessions cannot be adopted. Create a new retained-host thread.');
    return owner;
  }
  private resolve(row: RuntimeCommand, context: unknown): RuntimeBinding {
    if (!object(context) || typeof context.threadId !== 'string') throw new Error('Select a retained-host thread. Existing monolithic sessions are not imported.');
    const owner = this.binding(context.threadId);
    if (row.threadId && row.threadId !== owner.threadId || owner.openId !== row.openId
      || canonical(context) !== canonical(owner) || !this.current(owner)) throw new Error('Retained session owner, directory, backend or generation changed.');
    return owner;
  }
  private current(owner: RuntimeBinding): boolean {
    const retained = this.journal.snapshot().owners.find(row => row.threadId === owner.threadId);
    const thread = this.options.threads.getThread(owner.threadId);
    return !this.closed && this.journal.healthy && !!retained && retained.openId === owner.openId && retained.generation === owner.generation
      && !!thread && (thread.delegationWorkspaceGeneration ?? 0) === retained.contextGeneration && thread.workingDirectory === retained.cwd && this.options.pool.getBackendKey(owner.threadId) === retained.backend;
  }
  private async executor(binding: RuntimeBinding): Promise<IExecutor> {
    if (!this.current(binding)) throw new Error('Retained native ownership is stale.');
    const executor = this.options.pool.getExecutor(binding.threadId);
    if (!this.bridges.has(binding.threadId)) {
      if (!executor.configureManagedTools) throw new Error('Stable managed tool registration is unavailable.');
      const bridge = new ManagedToolBridge();
      try { await executor.configureManagedTools(await bridge.start(['scheduling'])); }
      catch (error) { await bridge.close(); throw error; }
      this.bridges.set(binding.threadId, bridge);
      // The bridge activation belongs to the native host, never a frontend lease.
      bridge.activate(async (name, args) => {
        if (this.stopping) throw new Error('Explicit native host retirement is in progress.');
        const scheduled = this.toolTurns.get(binding.threadId);
        const foreground = this.foregroundToolTurns.get(binding.threadId);
        if (scheduled && foreground) throw new Error('Concurrent native invocations cannot share a scheduling tool receipt. Retry after the foreground turn finishes.');
        const turn = scheduled?.id ?? foreground;
        if (!turn) throw new Error('No admitted native invocation owns this tool request.');
        const scope = this.tools.scope({ owner: binding, backend: binding.backend, messageId: turn,
          current: () => this.current(binding), run: (command, id) => this.schedule(binding, command, id, true),
          nativeAction: id => executor.nativeScheduleAction?.(id),
          present: async () => 'Schedule ownership is retained by the native host. Use /schedule list.' });
        // Each request scope drains its accepted operation, while receipts remain
        // in the host-owned operation registry across frontend replacement.
        try { return await scope.invoke(name, args); } finally { void scope.close().catch(() => {}); }
      });
    }
    return executor;
  }
  private async schedule(binding: RuntimeBinding, operation: ScheduleOperation, id: string, inTurn: boolean): Promise<ScheduleRecord[]> {
    if (!object(operation) || !['create', 'list', 'cancel'].includes(operation.kind) || !this.current(binding)) throw new Error('Invalid schedule operation.');
    if (operation.kind === 'list') return this.schedules.list(binding);
    const executor = await this.executor(binding);
    const run = async () => {
      if (!this.current(binding)) throw new Error('Schedule owner changed.');
      if (operation.kind === 'cancel') return [await this.schedules.cancel(binding, operation.id)];
      validateScheduleRule(operation.rule, Date.now()); validateSchedulePrompt(operation.prompt);
      if (!this.ready || !this.options.router.isConnected()) throw new Error('A Router with scheduled-result ACK support is required.');
      if (binding.backend === 'claude' && new ClaudeSandbox(this.options.guard, this.options.config.claude?.sandbox, binding.threadId).isRestricted()) throw new Error('Restricted native scheduling is unavailable.');
      const thread = this.options.threads.getThread(binding.threadId)!;
      return [await this.schedules.create(binding, { id, threadId: binding.threadId, backend: binding.backend, cwd: binding.cwd,
        rule: operation.rule, prompt: operation.prompt, command: this.options.config[binding.backend]?.command,
        model: thread.models?.[binding.backend] ?? (binding.backend === 'claude' ? thread.model ?? undefined : this.options.config[binding.backend]?.model), effort: thread.efforts?.[binding.backend] })];
    };
    return executor.withNativeScheduleOperation ? executor.withNativeScheduleOperation(id, () => this.current(binding), run, inTurn) : run();
  }
  private scheduleId(id: string): string { return 'host-' + createHash('sha256').update(id).digest('hex').slice(0, 48); }
  assertCanStop(): void {
    if (this.stopping || this.closed) return; // Retry only the already admitted stop.
    const state = this.journal.snapshot();
    if (!this.journal.healthy || !this.schedules.canRetireDrainedHosts() || this.schedules.hasPendingResults() || this.busy.size || this.toolTurns.size || this.foregroundToolTurns.size || state.nativeEvents.length
      || state.commands.some(command => command.status !== 'acknowledged')
      || state.owners.some(owner => this.options.pool.isThreadBusy(owner.threadId)
        || this.options.pool.getExistingExecutor(owner.threadId)?.hasPendingScheduleMutation?.())) {
      throw new Error('Native work or unacknowledged output is retained; explicitly cancel/drain it before host shutdown.');
    }
  }
  stop(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.stopWork) return this.stopWork;
    // This is explicit shutdown only, never frontend replacement. Admission
    // preserves ownership; it does not pretend already-drained hosts have exited.
    try {
      this.assertCanStop();
      this.schedules.beginDrainedHostRetirement();
    } catch (error) { return Promise.reject(error); }
    this.stopping = true;
    const operation = (async () => {
      if (!this.nativeHostsJoined) {
        await this.options.pool.destroyAll({ deleteData: false, shutdown: true });
        this.nativeHostsJoined = true;
      }
      // processClosed/group-exit callbacks may append AFTER destroy was called.
      // Keep owner validity and the durable event journal until they are settled.
      let tail: Promise<void>;
      do { tail = this.eventTail; await tail; } while (tail !== this.eventTail);
      if (!this.journal.healthy || this.journal.snapshot().nativeEvents.length) throw new Error('Native retirement event persistence remains unresolved.');
      await this.retrying;
      await this.schedules.finishDrainedHostRetirement();
      await this.schedules.destroy();
      for (const bridge of this.bridges.values()) await bridge.close();
      if (this.retryTimer) clearInterval(this.retryTimer);
      this.unsubscribe(); this.delivery.destroy(); this.options.router.disconnect(); this.journal.close();
      this.closed = true;
    })();
    this.stopWork = operation;
    void operation.finally(() => { if (!this.closed) this.stopWork = undefined; }).catch(() => {});
    return operation;
  }
}
