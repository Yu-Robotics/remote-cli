import fs from 'fs/promises';
import { isDeepStrictEqual } from 'node:util';
import type { AgyHookLease } from '../../scheduling/agy/AgyHookOwnership';
import { AgyChatHost } from './AgyChatHost';
import { agyHostScheduleHistory } from './AgySessionSelection';
import { creationReceipt, nativeRestartNotice, nativeWake, type TranscriptRecord } from '../../scheduling/agy/transcript';
import { AgyCommandTasks, type AgyCommandCheckpoint } from './AgyCommandTasks';
import { AgyPermissions } from './AgyPermissions';
import type { ApprovalAction } from '../../types';
import { ActivityTracker } from '../Activity';
import type { AcpContentBlock, AcpSessionResult } from '../acp/AcpTypes';
import { randomUUID } from 'crypto';
import { AcpClient, type AcpTransport, type AcpEventCallbacks, type AcpSessionSetup, type AcpToolCallUpdate } from '../acp/AcpClient';
import { applyAgySessionSettings } from './AgySessionSettings';
import { AgyAcpStartupError, type AgyAcpStartupStage } from './AgyAcpDiagnostics';
import type { AcpMcpServer } from '../acp/AcpTypes';
import type { ExecuteOptions, ExecuteResult } from '../IExecutor';
import { AgyScheduleHost } from '../../scheduling/agy/AgyScheduleHost';
import { AgyHookRelay, installAgyScheduleHooks } from '../../scheduling/agy/AgyHookRelay';
import { nativeBindings } from '../../native/NativeBindings';

export interface AgyAcpRuntimeOptions {
  command: string; home: string; cwd: string; threadId: string; env: NodeJS.ProcessEnv;
  model?: string; effort?: string; autoApprove: boolean;
  mcpServers?: AcpMcpServer[];
  sessionId?: string;
  worker?: boolean;
  /** Main chat whose schedule tools create host timers only. */
  hostScheduleChat?: boolean;
  commandCheckpoint?: AgyCommandCheckpoint;
  beforeSessionLoad?(): void;
  saveSession(id: string): void | Promise<void>;
  beforeAllocation?(): void;
  beforePrompt?(): void;
  settledPrompt?(reusable: boolean): void;
  /** Exact local group release only; this cannot certify empty native queues. */
  ownedSessionClosed(id: string, cleanHistory?: string, unpromptedHistory?: string, commands?: AgyCommandCheckpoint): void;
  /** Persist before the native schedule tool can run, even if its receipt is lost. */
  retainScheduleOwner(sessionId: string, hostId: string, retired: boolean): void;
  mapTool(name: string, args: Record<string, unknown>): { name: string; input: Record<string, unknown> };
}

/** ACP host for fresh main chat and qualified worker continuity. Loading never grants schedule admission. */
export class AgyAcpRuntime {
  private client?: AcpTransport;

  private host?: AgyScheduleHost;
  private chat?: AgyChatHost;
  private settings?: AcpSessionResult;
  private defaults?: { model?: string; effort?: string };
  private settingsBusy = false;
  private scheduleOperations = 0;
  private readonly permissions = new AgyPermissions();
  private relay?: AgyHookRelay;
  private restore?: AgyHookLease;
  private starting?: Promise<void>;
  private closing = false;
  private closePromise?: Promise<void>;
  private activity?: () => void;
  private closed = false;
  private allocationStarted = false;
  get allocationUnconfirmed(): boolean { return this.allocationStarted && !this.allocatedSessionId; }
  private relayFault = false;
  private continuityUnsafe = false;
  private hostScheduleSettled = false;
  private hostScheduleUnsafe = false;
  private prompted = false;
  private allocatedSessionId?: string;
  private active?: ExecuteOptions;
  private retained = false;
  private hostId = randomUUID();
  private tools = new Map<number, string>();
  private latestRecords: TranscriptRecord[] = [];
  private commands?: AgyCommandTasks;
  private controlRecords: TranscriptRecord[] = [];
  private readonly tracker = new ActivityTracker();
  private streamed = '';
  private question?: { args?: Record<string, unknown>; pendingCall?: string };
  private answerQuestion?: (answer: string | undefined) => void;
  private callbacks: AcpEventCallbacks;
  constructor(private readonly options: AgyAcpRuntimeOptions) {
    this.callbacks = {
      // ACP may flush old autonomous chunks into the next prompt. Only use it
      // before any managed timer exists; afterwards use current native records.
      onTextChunk: block => {
        this.activity?.();
        if (!this.retained && this.active && block.type === 'text' && typeof block.text === 'string') {
          this.streamed += block.text; this.active.onStream?.(block.text); this.active.onDisplayText?.(block.text); this.tracker.emitPublicText(block.text);
        }
      },
      onToolCall: (call: AcpToolCallUpdate & { name?: string }) => {
        if (this.question?.args && call.name === 'ask_question' && call.status === 'pending'
          && isDeepStrictEqual(this.question.args, call.rawInput)) this.question.pendingCall = call.toolCallId;
      },
      onToolResult: call => {
        const question = this.question;
        if (question && question.pendingCall === call.toolCallId) question.pendingCall = undefined;
      },
      onPermissionRequest: (title, choices) => this.permissions.request(title, choices, this.active, this.options.autoApprove),
    };
  }
  get sessionId(): string | undefined { return this.host?.sessionId ?? this.chat?.sessionId; }
  get hasJobs(): boolean { return this.retained; }
  get busy(): boolean { return this.settingsBusy || this.scheduleOperations > 0 || !this.closed && (!!this.active || !!this.starting || !this.blocked && !!this.host?.schedules.busy); }
  get blocked(): string | undefined { return this.chat?.blocked ?? this.host?.schedules.status.blocked; }
  private get foregroundReusable(): boolean { return !this.continuityUnsafe && !this.blocked && !this.retained && (this.chat?.reusable ?? true)
    && !this.controlRecords.some(row => nativeWake(row) || row.type === 'GENERIC' && row.status !== 'DONE'); }
  get reusable(): boolean { return this.foregroundReusable && !this.commands?.pending; }
  get pendingMutation(): boolean { return !!this.host?.schedules.pendingMutation; }
  get cleanupMutationPending(): boolean { return !!this.host?.schedules.cleanupMutationPending; }
  /** Admission to retire our host, never proof that the host has already exited. */
  get canRetireForContextReset(): boolean {
    return !this.busy && !this.pendingMutation && (!this.retained || this.host?.schedules.cancelledBeforeWake === true);
  }
  get running(): boolean { return !!this.client && !this.closed; }

  private get hostScheduleSafe(): boolean {
    return this.options.hostScheduleChat === true && !!this.chat && !this.closing && !this.closed
      && !this.hostScheduleUnsafe && !this.continuityUnsafe && !this.relayFault && !this.blocked && !this.retained
      && !this.settingsBusy;
  }
  get hostScheduleAvailable(): boolean {
    return this.hostScheduleSafe && !this.commands?.pending && (this.active !== undefined || this.hostScheduleSettled && this.reusable);
  }
  get waitingForCommand(): boolean {
    return this.hostScheduleSafe && !this.active && this.hostScheduleSettled && this.foregroundReusable && this.commands?.pending === true;
  }

  async start(): Promise<void> {
    if (this.closing || this.closed) throw new Error('AGY ACP host is retired.');
    if (this.host || this.chat) return;
    if (this.starting) return this.starting;
    this.starting = this.open();
    try { await this.starting; }
    catch (error) {
      try { await this.close(); }
      catch (cleanup) { throw new AgyAcpStartupError('startup', error, cleanup); }
      throw error;
    } finally { this.starting = undefined; }
  }
  private async open(): Promise<void> {
    let stage: AgyAcpStartupStage = 'native-helper';
    try { await this.openSession(next => { stage = next; }); }
    catch (error) { throw new AgyAcpStartupError(stage, error); }
  }
  private async openSession(setStage: (stage: AgyAcpStartupStage) => void): Promise<void> {
    const native = nativeBindings();
    if (!native.readChunk || !native.openOutputChild) throw new Error('AGY ACP native helper support is unavailable. Reinstall remote-cli on a published Linux, macOS or Windows x64/ARM64 target.');
    setStage('hooks');
    await fs.mkdir(this.options.home, { recursive: true, mode: 0o700 });
    if (this.closing) throw new Error('AGY startup was retired.');
    this.relay = new AgyHookRelay(this.options.home, (event, payload, rows) => {
      if (!this.host && !this.chat) throw new Error('AGY hook arrived before session admission.');
      this.activity?.(); this.latestRecords = rows;
      let controls = rows;
      if (this.commands && !this.hostScheduleUnsafe) {
        try {
          controls = this.commands.observe(event, payload, rows, !!this.active);
          if (!this.active && event === 'Stop' && (payload.terminationReason !== 'NO_TOOL_CALL' || payload.error !== '')) {
            this.hostScheduleUnsafe = true;
          }
        } catch { this.hostScheduleUnsafe = true; }
      } else if (this.options.hostScheduleChat && !this.active && event !== 'SessionStart') this.hostScheduleUnsafe = true;
      this.controlRecords = controls;
      if (this.options.hostScheduleChat && controls.some(row => row.source === 'SYSTEM' && row.type === 'SYSTEM_MESSAGE'
          && /sender=/.test(row.content ?? '') && !nativeRestartNotice(row))) this.hostScheduleUnsafe = true;
      if (this.chat?.hasListDenial && this.hostScheduleUnsafe) this.chat.fence('AGY hook evidence changed after a list denial; explicit clear is required.');
      const decision = this.options.hostScheduleChat && !this.active && event === 'PreToolUse'
        ? { decision: 'deny' as const, reason: 'AGY command notifications cannot start another tool.' }
        : this.chat ? this.chat.accept(event, payload, controls, !!this.active && this.active.hostScheduleSessionId === undefined
          && !!this.options.hostScheduleChat && !this.options.worker && !this.hostScheduleUnsafe && !this.relayFault
          && !this.commands?.pending && !this.closing && !this.settingsBusy && !this.scheduleOperations)
          : this.host!.schedules.accept(event, payload, controls);
      if (!this.continuityUnsafe && (event === 'PreToolUse' && decision.decision === 'deny'
        || controls.some(row => creationReceipt(row, payload.conversationId as string, row.step_index)))) {
        this.continuityUnsafe = true;
        this.options.settledPrompt?.(false);
      }
      if (this.active && decision.decision !== 'deny') {
        if (event === 'PreToolUse') {
          const call = payload.toolCall as { id: string; name: string; args: Record<string, unknown> };
          if (call && Number.isSafeInteger(payload.stepIdx)) {
            if (decision.decision === 'allow') {
              this.commands?.observeTool(payload.stepIdx as number, call.name, call.id, call.args, this.options.cwd);
            }
            if (call.name === 'ask_question' && this.question) {
              this.question.args = call.args;
              this.question.pendingCall = undefined;
            }
            this.tools.set(payload.stepIdx as number, call.id);
            const mapped = this.options.mapTool(call.name, call.args);
            const description = typeof call.args.toolSummary === 'string' ? call.args.toolSummary : undefined;
            this.active.onToolUse?.({ id: call.id, ...mapped, ...(description ? { description } : {}) });
            this.tracker.emitTool(mapped.name, mapped.input, description);
          }
        }
        for (const [step, id] of this.tools) {
          const row = rows.find(row => row.step_index === step && row.type === 'GENERIC' && row.status === 'DONE');
          if (row) { this.active.onToolResult?.({ tool_use_id: id, content: (row.content ?? '').slice(0, 32768), is_error: event === 'PostToolUse' && !!payload.error }); this.tools.delete(step); }
        }
      }
      return decision;
    }, () => {
      this.relayFault = true;
      this.chat?.fence('AGY hook relay failed; chat state is unconfirmed.');
      this.host?.schedules.fence('AGY hook relay failed; native schedule state is unconfirmed.');
      this.answerQuestion?.(undefined);
    });
    this.restore = await installAgyScheduleHooks(this.options.home, await this.relay.start());
    if (this.closing) throw new Error('AGY startup was retired.');
    // Consume a clean checkpoint under the per-HOME kernel gate, before spawning.
    if (this.options.sessionId) this.options.beforeSessionLoad?.();
    const args = ['acp', '--stdio', '--process-per-session', '--disable-telemetry'];
    if (this.options.autoApprove) args.push('--dangerously-skip-permissions');
    setStage('process');
    this.client = this.restore.run(() => new AcpClient(this.options.command, args, this.options.cwd, this.callbacks, true,
      { env: this.options.env, delegationWorker: true, onStderr: () => {} }));
    setStage('initialize');
    await this.client.initialize();
    if (this.closing) throw new Error('AGY startup was retired.');
    const setup: AcpSessionSetup = async (session, configure) => {
      if (typeof session?.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(session.sessionId)) throw new Error('AGY ACP returned no valid session identity.');
      this.allocatedSessionId = session.sessionId;
      setStage('session-save');
      try { await this.options.saveSession(session.sessionId); }
      catch { throw new Error('AGY ACP session identity could not be persisted. No prompt was sent.'); }
      if (this.closing) throw new Error('AGY startup was retired.');
      setStage('session-settings');
      this.defaults = { model: session.configOptions?.find(o => o.id === 'model')?.currentValue, effort: session.configOptions?.find(o => o.id === 'thought_level')?.currentValue };
      this.settings = session;
      await applyAgySessionSettings(session, async (id, value) => {
        if (this.closing) throw new Error('AGY startup was retired.');
        const result = await configure(id, value);
        this.settings = result;
        if (this.closing) throw new Error('AGY startup was retired.');
        return result;
      }, this.options);
      if (this.closing) throw new Error('AGY startup was retired.');
    };
    let session: { sessionId?: string };
    // A lost/malformed allocation reply is not proof that no ACP session exists.
    if (!this.options.sessionId) this.options.beforeAllocation?.();
    this.allocationStarted = true;
    setStage(this.options.sessionId ? 'session-load' : 'session-create');
    if (this.options.sessionId) {
      if (!this.client.loadSessionWithSetup) throw new Error('AGY ACP session load setup is unavailable.');
      session = await this.client.loadSessionWithSetup(this.options.sessionId, this.options.cwd, this.options.mcpServers, setup);
      if (session.sessionId !== this.options.sessionId) throw new Error('AGY loaded a different session; no prompt was sent.');
    } else {
      if (!this.client.newSessionWithSetup) throw new Error('AGY ACP initial session setup is unavailable.');
      session = await this.client.newSessionWithSetup(this.options.cwd, this.options.mcpServers, setup);
    }
    if (this.closing) throw new Error('AGY startup was retired.');
    if (!session.sessionId) throw new Error('AGY ACP returned no session identity.');
    if (this.allocatedSessionId !== session.sessionId) throw new Error('AGY ACP initial session setup was not confirmed.');
    setStage('host-admission');
    if (this.relayFault) throw new Error('AGY hook relay failed before session admission.');
    if (this.options.worker || this.options.sessionId || this.options.hostScheduleChat) {
      this.chat = new AgyChatHost(this.client, session.sessionId, this.options.cwd, this.options.threadId);
      if (this.options.hostScheduleChat && !this.options.worker) {
        this.commands = new AgyCommandTasks(session.sessionId, this.options.home, this.options.commandCheckpoint);
      }
      this.relay.bindSession(session.sessionId);
    } else {
    this.host = new AgyScheduleHost(this.client, session.sessionId, {
      threadId: this.options.threadId, cwd: this.options.cwd,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      hostId: this.hostId, isCurrent: () => !this.closing,
      beforeMutation: async () => {
        this.options.retainScheduleOwner(session.sessionId!, this.hostId, false);
        this.retained = true;
      },
    });
    this.host.bind(this.relay);
    }
    void this.client.waitForExit!().then(() => {
      this.answerQuestion?.(undefined);
      if (!this.closing) { this.host?.schedules.processClosed(false); this.chat?.fence('AGY process closed unexpectedly.'); }
    });
  }

  async execute(prompt: string, options: ExecuteOptions): Promise<ExecuteResult> {
    await this.start();
    if (this.active || this.settingsBusy) throw new Error('AGY foreground turn is already active.');
    if (this.commands?.pending) throw new Error('AGY command completion is pending.');
    this.active = options; this.streamed = ''; this.tools.clear(); this.tracker.setCallback(options.onActivity); this.tracker.reset();
    this.hostScheduleSettled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inactive: ReturnType<typeof setTimeout> | undefined;
    this.activity = () => {
      if (inactive) clearTimeout(inactive);
      if (options.inactivityTimeout && options.inactivityTimeout > 0) inactive = setTimeout(() => this.cancelForeground(), options.inactivityTimeout);
    };
    this.activity();
    try {
      if (options.timeout && options.timeout > 0) timer = setTimeout(() => this.cancelForeground(), options.timeout);
      this.options.beforePrompt?.();
      const blocks = [{ type: 'text', text: options.resolvePrompt?.(this.sessionId ?? null) ?? prompt },
        ...(options.attachments ?? []).filter(item => item.type === 'image').map(item => ({ type: 'image', data: item.data, mimeType: item.mimeType }))];
      this.prompted = true;
      const work = (this.chat ?? this.host!).prompt(blocks, input => this.promptWithQuestions(input));
      const result = await work;
      if (result.stopReason === 'cancelled' && !this.retained && !this.relayFault && !this.continuityUnsafe && !this.chat
        && this.host?.schedules.status.blocked?.startsWith('AGY foreground cancelled:')) {
        this.chat = new AgyChatHost(this.client!, this.sessionId!, this.options.cwd, this.options.threadId, this.latestRecords);
        this.host = undefined;
      }
      this.options.settledPrompt?.(this.reusable && result.stopReason !== 'cancelled');
      const completed = result.success && result.stopReason === 'end_turn';
      this.hostScheduleSettled = completed && this.foregroundReusable;
      // A confirmed list denial keeps ordinary chat live. continuityUnsafe already
      // disqualifies this host from scheduling, reconnect and durable checkpoints.
      if (!this.hostScheduleSettled && !(completed && this.chat?.hasListDenial && this.chat.reusable)) this.hostScheduleUnsafe = true;
      // Current native Stop gives the final text without replaying buffered ACP
      // output. With timers, this is a batch projection, not token streaming.
      if (result.output && (this.retained || !this.streamed)) {
        options.onStream?.(result.output); options.onDisplayText?.(result.output);
      }
      return { success: result.success, output: result.output, sessionAbbr: this.sessionId?.slice(0, 8),
        ...(!result.success && { error: result.output || 'AGY native turn failed.' }) };
    } catch (error) {
      this.hostScheduleUnsafe = true;
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      if (inactive) clearTimeout(inactive);
      this.permissions.cancel(); this.answerQuestion?.(undefined); this.question = undefined;
      this.tracker.reset(); this.tracker.setCallback(undefined); this.activity = undefined; this.active = undefined; this.tools.clear();
      this.commands?.endForeground();
    }
  }
  private async promptWithQuestions(blocks: AcpContentBlock[]): Promise<{ stopReason: string }> {
    for (;;) {
      const question: NonNullable<AgyAcpRuntime['question']> = this.question = {};
      const terminal = await this.client!.prompt(this.sessionId!, blocks);
      if (terminal.stopReason !== 'end_turn' || !question.pendingCall || !question.args || this.blocked || this.closing
        || !(this.chat ?? this.host!.schedules).suspendForeground()) return terminal;
      // ACP settles its request while the hook invocation remains open.
      // The next native prompt on this session resumes that invocation.
      this.activity?.();
      const answer = await new Promise<string | undefined>(resolve => {
        this.answerQuestion = value => { this.answerQuestion = undefined; resolve(value); };
        const questions = this.retained && Array.isArray(question.args?.questions) ? question.args.questions : [];
        const text = questions.flatMap(item => typeof item?.question === 'string' && Array.isArray(item.options)
          ? [item.question, ...item.options.filter((option: unknown) => typeof option === 'string')
            .map((option: string, index: number) => `- [${index + 1}] ${option}`)] : []).join('\n');
        const message = `\n${text ? text + '\n' : ''}Reply in this thread to continue.\n`;
        this.active?.onStream?.(message);
        if (text) this.active?.onDisplayText?.(text);
      });
      if (answer === undefined || this.closing || this.blocked) return { stopReason: 'cancelled' };
      this.activity?.();
      blocks = [{ type: 'text', text: answer }];
    }
  }
  async abort(): Promise<boolean> {
    this.permissions.cancel();
    return this.cancelForeground();
  }
  private cancelForeground(): boolean {
    if (this.answerQuestion) {
      this.continuityUnsafe = true;
      this.chat?.fence('AGY question cancellation could not be confirmed.');
      this.answerQuestion(undefined);
    }
    return (this.chat ?? this.host)?.cancelForeground() ?? false;
  }
  async withOperation<T>(id: string, current: () => boolean, run: () => Promise<T>, inTurn: boolean): Promise<T> {
    if (this.answerQuestion) throw new Error('AGY is waiting for the answer to a question.');
    if (this.settingsBusy) throw new Error('AGY settings are changing; native scheduling is unavailable.');
    this.scheduleOperations++;
    try {
      await this.start();
      if (!this.host) throw new Error('Native scheduling is unavailable for loaded sessions and managed workers.');
      return await this.host.schedules.withOperation(id, current, run, inTurn);
    } finally { this.scheduleOperations--; }
  }
  action(id: string) { return this.host?.schedules.action(id); }
  isWaitingInput(): boolean { return this.permissions.waiting || !!this.answerQuestion; }
  sendInput(input: string): boolean {
    if (!this.answerQuestion) return this.permissions.input(input);
    if (!input.trim()) return false;
    this.answerQuestion(input);
    return true;
  }
  respondToApproval(id: string, action: ApprovalAction): boolean { return this.permissions.respond(id, action); }
  async waitForManagedProcessGroupExit(): Promise<void> {
    if (this.client && !this.client.waitForManagedProcessGroupExit) throw new Error('AGY process group cannot be confirmed.');
    await this.client?.waitForManagedProcessGroupExit?.();
  }
  async changeSettings(requested: { model?: string; effort?: string; mode?: string; resetModel?: boolean; resetEffort?: boolean }): Promise<void> {
    if (this.busy || !this.reusable) throw new Error('AGY settings require idle chat without retained native schedules or uncertain work.');
    this.settingsBusy = true;
    try {
      await this.start();
      const selection = { mode: requested.mode, model: requested.resetModel ? this.defaults?.model : requested.model,
        effort: requested.resetEffort ? this.defaults?.effort : requested.effort };
      if (requested.resetModel && !selection.model || requested.resetEffort && !selection.effort) throw new Error('AGY native setting default is unavailable.');
      // Controls revoke the original scheduling token. No later setting recreates it.
      if (!this.chat) this.chat = new AgyChatHost(this.client!, this.sessionId!, this.options.cwd, this.options.threadId, this.latestRecords);
      this.host = undefined;
      await applyAgySessionSettings(this.settings!, async (id, value) => {
        const result = await this.client!.setConfigOption(this.sessionId!, id, value);
        this.settings = result; return result;
      }, selection);
    } catch (error) { this.chat?.fence('AGY setting outcome is unconfirmed; no further prompt was sent.'); throw error; }
    finally { this.settingsBusy = false; }
  }
  /** Join the exact tracked group before restoring hooks. Retirement does not
   * authorize loading this conversation: old SYSTEM reminders may survive. */
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.active || this.settingsBusy || this.scheduleOperations) this.hostScheduleUnsafe = true;
    this.closing = true; this.permissions.cancel(); this.answerQuestion?.(undefined);
    return this.closePromise ??= (async () => {
      await this.starting?.catch(() => {});
      await this.finishClose();
    })().catch(error => { this.closePromise = undefined; throw error; });
  }
  private async finishClose(): Promise<void> {
    this.closing = true;
    if (this.host) await this.host.close();
    else { this.client?.destroy(); await this.client?.waitForExit?.(); }
    if (this.client && !this.client.waitForManagedProcessGroupExit) throw new Error('AGY exact process-group retirement cannot be confirmed.');
    await this.client?.waitForManagedProcessGroupExit?.();
    if (this.host) {
      if (this.retained) this.options.retainScheduleOwner(this.host.sessionId, this.hostId, true);
      this.host.schedules.processClosed(true);
    }
    let cleanHistory: string | undefined;
    let unpromptedHistory: string | undefined;
    if (this.options.hostScheduleChat && !this.hostScheduleUnsafe && !this.relayFault && this.reusable && this.sessionId && this.relay) {
      try {
        if (this.hostScheduleSettled) {
          const history = agyHostScheduleHistory(this.options.home, this.sessionId);
          if (await this.relay.confirmsTerminal(this.latestRecords)) cleanHistory = history;
        } else if (!this.prompted && !this.latestRecords.length) {
          unpromptedHistory = agyHostScheduleHistory(this.options.home, this.sessionId, true);
        }
      } catch { /* Missing history withholds checkpoint admission after an otherwise confirmed exit. */ }
    }
    await this.relay?.close();
    await this.restore?.(); this.restore = undefined;
    if (!this.reusable) this.options.settledPrompt?.(false);
    if (this.host || this.chat) {
      const safe = !this.hostScheduleUnsafe && !this.relayFault && this.reusable;
      this.options.ownedSessionClosed(this.sessionId!, safe ? cleanHistory : undefined, safe ? unpromptedHistory : undefined,
        safe && cleanHistory ? this.commands?.snapshot() : undefined);
    }
    this.closed = true;

  }
}
