import fs from 'fs/promises';
import { isDeepStrictEqual } from 'node:util';
import type { AgyHookLease } from '../../scheduling/agy/AgyHookOwnership';
import { AgyChatHost, restoreAgyToolErrors } from './AgyChatHost';
import { agyHostScheduleHistory } from './AgySessionSelection';
import { creationReceipt, nativeRestartNotice, nativeWake, receiptText, type TranscriptRecord } from '../../scheduling/agy/transcript';
import { AgyCommandTasks, type AgyCommandCheckpoint } from './AgyCommandTasks';
import { agyHistoryDigest, restoreAgyVerifiedHistory, verifyAgyTerminalHistory, type AgyVerifiedHistory } from './AgyRecoveredHistory';
import { retiredWorkerHistory, workerAbortBoundary, workerBoundary, workerHistoryPrefix, workerNotice } from './AgyWorkerAbortHistory';
import { AgyPermissions } from './AgyPermissions';
import type { ApprovalAction } from '../../types';
import { ActivityTracker } from '../Activity';
import type { AcpContentBlock, AcpSessionResult } from '../acp/AcpTypes';
import { randomUUID } from 'crypto';
import { AcpClient, type AcpTransport, type AcpEventCallbacks, type AcpSessionSetup, type AcpToolCallUpdate } from '../acp/AcpClient';
import { applyAgySessionSettings } from './AgySessionSettings';
import { AgyAcpStartupError, type AgyAcpStartupStage } from './AgyAcpDiagnostics';
import type { AcpMcpServer } from '../acp/AcpTypes';
import type { AgyHumanConfirmation, ExecuteOptions, ExecuteResult } from '../IExecutor';
import { AgyScheduleHost } from '../../scheduling/agy/AgyScheduleHost';
import { AgyHookRelay, installAgyScheduleHooks } from '../../scheduling/agy/AgyHookRelay';
import { nativeBindings } from '../../native/NativeBindings';

function foreignMessage(row: TranscriptRecord): boolean {
  return row.source === 'SYSTEM' && row.type === 'SYSTEM_MESSAGE'
    && /sender=/.test(row.content ?? '') && !nativeRestartNotice(row);
}

export interface AgyAcpRuntimeOptions {
  command: string; home: string; cwd: string; threadId: string; env: NodeJS.ProcessEnv;
  model?: string; effort?: string; autoApprove: boolean;
  mcpServers?: AcpMcpServer[];
  sessionId?: string;
  worker?: boolean;
  managedCoordinator?: boolean;
  /** Main chat whose schedule tools create host timers only. */
  hostScheduleChat?: boolean;
  commandCheckpoint?: AgyCommandCheckpoint;
  toolErrorDigest?: string;
  /** Checkpointed historical prefix verified after authenticated manual recovery. */
  verifiedHistory?: AgyVerifiedHistory;
  validatedChatLoad?: boolean;
  beforeSessionLoad?(): void;
  workerHistory?: AgyVerifiedHistory;
  claimWorkerLoad?(): void;
  verifyWorkerLoad?(): void;
  workerClosed?(prefix?: AgyVerifiedHistory, interrupted?: boolean): void;
  consumeManualConfirmation?(): void;
  beforeManualLoad?(): void;
  saveSession(id: string): void | Promise<void>;
  beforeAllocation?(): void;
  beforePrompt?(): void;
  settledPrompt?(reusable: boolean): void;
  /** Exact local group release only; this cannot certify empty native queues. */
  ownedSessionClosed(id: string, cleanHistory?: string, unpromptedHistory?: string, commands?: AgyCommandCheckpoint, toolErrorDigest?: string,
    verifiedHistory?: AgyVerifiedHistory): void;
  /** Persist before the native schedule tool can run, even if its receipt is lost. */
  retainScheduleOwner(sessionId: string, hostId: string, retired: boolean): void;
  mapTool(name: string, args: Record<string, unknown>): { name: string; input: Record<string, unknown> };
}

interface RecoveryQuestionAuthority {
  routeCurrent(): boolean;
  consume(answer: AgyHumanConfirmation): void;
  check(answer: AgyHumanConfirmation): void;
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
  private idleChatExited = false;
  /** Transport exit observed between settled main-chat turns. Group and lease still require close(). */
  get exitedBetweenTurns(): boolean { return this.idleChatExited; }
  private allocationStarted = false;
  get allocationUnconfirmed(): boolean { return this.allocationStarted && !this.allocatedSessionId; }
  private relayFault = false;
  private continuityUnsafe = false;
  private manualTurnPending: boolean;
  private humanQueryAdmission?: { open?: () => void };
  private ordinaryMain = false;
  private workerInFlight = false;
  private workerAbort?: { prefix: AgyVerifiedHistory; confirmed: boolean };
  private workerFault = false;
  private readonly retiredWorkerCommands = new Set<number>();
  private idleStop = false;
  private recoveredHistory?: AgyVerifiedHistory;
  private readonly acceptedMessages = new Map<number, TranscriptRecord>();
  private hostScheduleSettled = false;
  private hostScheduleUnsafe = false;
  private commandState = 'settled';
  private readonly commandCorrelation = randomUUID().slice(0, 8);
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
  private nativeVersion?: string;
  private streamed = '';
  private question?: { args?: Record<string, unknown>; pendingCall?: string };
  private unattendedInput?: () => void;
  private questionAuth?: RecoveryQuestionAuthority;
  private answerQuestion?: (answer: string | undefined, source?: AgyHumanConfirmation) => void;
  private callbacks: AcpEventCallbacks;
  constructor(private readonly options: AgyAcpRuntimeOptions) {
    this.manualTurnPending = !!options.beforeManualLoad;
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
        if (this.workerAbort) this.workerFault = true;
        this.chat?.observeDispatch(call);
        if (this.question?.args && call.name === 'ask_question' && call.status === 'pending'
          && isDeepStrictEqual(this.question.args, call.rawInput)) this.question.pendingCall = call.toolCallId;
      },
      onToolResult: (call: AcpToolCallUpdate & { name?: string }) => {
        this.chat?.observeDispatch(call);
        const question = this.question;
        if (question && question.pendingCall === call.toolCallId) question.pendingCall = undefined;
      },
      onPermissionRequest: async (title, choices) => {
        if (this.workerAbort) { this.workerFault = true; return -1; }
        const turn = this.active;
        const index = await this.permissions.request(title, choices, turn, this.options.autoApprove, this.unattendedInput);
        if (turn && this.active === turn && !choices[index]?.kind.startsWith('allow')) {
          this.permissionDeclined = true;
          if (this.options.worker) this.workerFault = true;
        }
        return index;
      },
    };
  }
  get sessionId(): string | undefined { return this.host?.sessionId ?? this.chat?.sessionId; }
  get hasJobs(): boolean { return this.retained; }
  get busy(): boolean { return this.settingsBusy || this.scheduleOperations > 0 || !this.closed && (!!this.active || !!this.starting || !this.blocked && !!this.host?.schedules.busy); }
  get blocked(): string | undefined { return this.chat?.blocked ?? this.host?.schedules.status.blocked; }
  private permissionDeclined = false;
  private get foregroundReusable(): boolean {
    return !this.continuityUnsafe && !this.blocked && !this.retained && (this.chat?.reusable
      ?? !this.controlRecords.some(row => nativeWake(row) || row.type === 'GENERIC' && row.status !== 'DONE'));
  }
  private get checkpointEligible(): boolean {
    return this.foregroundReusable && !this.commands?.pending;
  }
  // Managed-tool reconnection and control changes retain their own admission rules.
  get reusable(): boolean {
    return !this.workerAbort && this.checkpointEligible && !this.commands?.liveDenial && !this.options.commandCheckpoint?.idleDenialHistory
      && !this.options.toolErrorDigest && !this.chat?.hasForegroundToolErrors;
  }
  /** Reopening a recovered prefix requires its durable verification receipt. */
  get requiresVerifiedReconnect(): boolean { return !!this.recoveredHistory; }
  get canDeferToolsAfterVerifiedError(): boolean {
    return this.options.validatedChatLoad === true && !this.options.worker && !this.busy && this.hostScheduleAvailable
      && !this.commands?.liveDenial && !this.permissionDeclined && !!this.chat?.hasForegroundToolErrors;
  }
  get needsHumanContinuation(): boolean {
    return !!this.chat?.humanContinuation && !this.chat.reusable && !this.commands?.pending && !this.blocked
      && !this.retained && !this.closing && !this.closed && !this.relayFault && !this.permissionDeclined;
  }

  get pendingMutation(): boolean { return !!this.host?.schedules.pendingMutation; }
  get cleanupMutationPending(): boolean { return !!this.host?.schedules.cleanupMutationPending; }
  /** Admission to retire our host, never proof that the host has already exited. */
  get canRetireForContextReset(): boolean {
    return !this.busy && !this.pendingMutation && (!this.retained || this.host?.schedules.cancelledBeforeWake === true);
  }
  get running(): boolean { return !!this.client && !this.closed; }

  private get hostScheduleSafe(): boolean {
    return this.options.hostScheduleChat === true && !this.options.commandCheckpoint?.idleDenialHistory && !!this.chat && !this.closing && !this.closed
      && !this.chat.restrictedToHuman && !this.hostScheduleUnsafe && !this.continuityUnsafe && !this.relayFault && !this.blocked && !this.retained
      && !this.settingsBusy;
  }
  get hostScheduleAvailable(): boolean {
    return !this.manualTurnPending && this.hostScheduleSafe && !this.commands?.pending && (this.active !== undefined || this.hostScheduleSettled && this.foregroundReusable);
  }
  get canScheduleAfterManualResume(): boolean {
    return !!this.options.beforeManualLoad && this.hostScheduleAvailable;
  }
  get waitingForCommand(): boolean {
    return this.hostScheduleSafe && !this.active && this.hostScheduleSettled && this.commands?.pending === true;
  }

  private reportCommandState(): void {
    if (!this.commands) return;
    const outstanding = this.commands.outstandingCount;
    const state = this.blocked ? 'unconfirmed' : outstanding ? 'waiting-exit' : this.commands.pending ? 'waiting-terminal' : 'settled';
    if (state === this.commandState) return;
    this.commandState = state;
    console.debug('[AGY command]', { state, outstanding, correlation: this.commandCorrelation });
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
      if (this.manualTurnPending) this.idleStop = event === 'Stop' && payload.fullyIdle === true && payload.continuationActive === false;
      let controls = rows;
      const aborted = this.workerAbort;
      if (aborted) {
        // Cancellation can race with final hooks or immediate process destruction.
        // Do not dispatch any new work, even while ACP is still acknowledging cancel.
        if (payload.cwd !== this.options.cwd || payload.conversationId !== this.sessionId || payload.hookEventName !== event
          || !workerHistoryPrefix(rows, aborted.prefix) || event === 'PreToolUse' || payload.error
          || event === 'Stop' && (payload.continuationActive === true
            || !['NO_TOOL_CALL', 'CANCELLED', 'USER_CANCELLED'].includes(String(payload.terminationReason)))) this.workerFault = true;
        return event === 'PreToolUse' ? { decision: 'deny', reason: 'AGY worker was aborted.' }
          : event === 'PreInvocation' ? { terminationBehavior: 'terminate' } : {};
      }
      const history = this.options.workerHistory ?? this.recoveredHistory;
      if (history) {
        const prefix = rows.slice(0, history.count);
        if (prefix.length !== history.count || agyHistoryDigest(prefix) !== history.digest
          || (event === 'PreInvocation' && Number(payload.initialNumSteps) <= history.lastStep)
          || (['PreToolUse', 'PostToolUse'].includes(event) && Number(payload.stepIdx) <= history.lastStep)) {
          this.hostScheduleUnsafe = true;
          this.chat?.fence('AGY recovered history changed before the current turn.');
        }
        // Prior command receipts can remain RUNNING after reboot. Only this host's
        // new rows can establish ownership of a command or authorize tool management.
        controls = rows.slice(history.count).filter(row => {
          if (this.options.workerHistory && this.commands) {
            if (this.acceptedMessages.has(row.step_index)) return false;
            if (!row.tool_calls?.length && nativeRestartNotice(row, 'user force cancellation')) {
              this.acceptedMessages.set(row.step_index, structuredClone(row));
              return false;
            }
            const target = this.commands.retiredCommandExit(row, this.retiredWorkerCommands);
            if (target !== undefined) {
              this.retiredWorkerCommands.delete(target);
              this.acceptedMessages.set(row.step_index, structuredClone(row));
              return false;
            }
          }
          const wake = nativeWake(row);
          if (!wake) return true;
          if (this.manualTurnPending && this.active && wake.sender.startsWith(this.sessionId + '/task-')
            && Number(wake.sender.slice(wake.sender.lastIndexOf('-') + 1)) <= history.lastStep) {
            this.hostScheduleUnsafe = true;
            if (!this.acceptedMessages.has(row.step_index)) this.acceptedMessages.set(row.step_index, structuredClone(row));
          }
          return !this.acceptedMessages.has(row.step_index);
        });
      }
      if (this.options.workerHistory && controls.some(row => row.type === 'SYSTEM_MESSAGE' && !workerNotice(row) && !nativeWake(row))) {
        this.chat?.fence('AGY worker received an unowned native message.');
      }
      const ordinaryHost = !this.options.worker && (!this.options.sessionId || this.options.validatedChatLoad === true
        || !!this.options.beforeManualLoad && !this.manualTurnPending && !this.hostScheduleUnsafe);
      const observeChat = !this.closing && !this.relayFault && !this.blocked;
      if (this.commands && observeChat && (!this.options.worker || this.active)) {
        try {
          if (payload.cwd !== this.options.cwd) throw new Error('AGY command working directory changed.');
          controls = this.commands.observe(event, payload, controls, !!this.active, ordinaryHost || this.hostScheduleSafe && this.hostScheduleSettled, this.ordinaryMain);
          if (this.options.worker && this.commands.observedBackgroundCommand && event === 'Stop' && payload.terminationReason === 'NO_TOOL_CALL'
            && (this.commands.pending || payload.fullyIdle !== true || payload.continuationActive !== false)) {
            throw new Error('AGY worker stopped before its background command settled.');
          }
          if (!this.active && event === 'Stop' && !this.commands.idleDecision && (payload.terminationReason !== 'NO_TOOL_CALL' || payload.error !== ''
            || payload.continuationActive !== false || !(payload.fullyIdle === true || payload.fullyIdle === false && this.commands.outstandingCount > 0))) {
            throw new Error('AGY command notification Stop is unconfirmed.');
          }
        } catch (error) {
          this.hostScheduleUnsafe = true;
          const reason = this.commands.liveDenial ? 'AGY idle command denial is unconfirmed.'
            : error instanceof Error ? error.message : 'AGY command evidence is unconfirmed.';
          this.chat?.fence(reason + ' Use explicit /clear to start a fresh conversation.');
        }
      } else if (this.options.hostScheduleChat && !this.active && event !== 'SessionStart') this.hostScheduleUnsafe = true;
      this.controlRecords = controls;
      if (this.acceptedMessages.size) {
        const matched = rows.reduce((count, row) =>
          count + Number(isDeepStrictEqual(this.acceptedMessages.get(row.step_index), row)), 0);
        if (matched !== this.acceptedMessages.size) this.chat?.fence('Previously accepted AGY messages changed after manual recovery.');
      }
      if (this.options.hostScheduleChat && controls.some(row => foreignMessage(row) && !this.acceptedMessages.has(row.step_index))) {
        this.hostScheduleUnsafe = true;
        if (!this.manualTurnPending || !this.active) this.chat?.fence('AGY command notification ownership is unconfirmed. Use explicit /clear to start a fresh conversation.');
      }
      const idleDecision = !this.active && observeChat && !this.blocked ? this.commands?.idleDecision : undefined;
      const ordinaryCommands = ordinaryHost && !this.chat?.restrictedToHuman && this.active?.hostScheduleSessionId === undefined
        ? this.commands : undefined;
      const scheduledHost = ordinaryHost && this.active?.hostScheduleSessionId !== undefined
        && this.active.hostScheduleSessionId === this.sessionId && this.hostScheduleSafe;
      // The verified prefix was excluded above. Track tool outcomes from this live
      // human turn even when the recovered history permanently excludes timers.
      const recoveredForeground = !!history && !this.options.worker && !!this.active
        && this.active.hostScheduleSessionId === undefined;
      let decision = this.options.hostScheduleChat && !this.active && event === 'PreToolUse'
        ? idleDecision ?? { decision: 'deny' as const, reason: 'AGY command notifications cannot start another tool.' }
        : this.chat ? this.chat.accept(event, payload, controls, !!this.active && !!ordinaryCommands
          && !!this.options.hostScheduleChat && observeChat && !this.blocked
          && !this.settingsBusy && !this.scheduleOperations && !this.permissionDeclined, this.commands, rows,
          (ordinaryHost || scheduledHost || recoveredForeground) && observeChat && !this.permissionDeclined)
          : this.host!.schedules.accept(event, payload, controls);
      if (this.unattendedInput && event === 'PreToolUse' && decision.decision === 'allow'
        && (payload.toolCall as { name?: string } | undefined)?.name === 'ask_question') {
        decision = { decision: 'deny', reason: 'The scheduled AGY turn requires user input.' };
        this.unattendedInput();
      }
      if (this.options.worker && (decision.decision === 'deny' || this.blocked || event === 'PostToolUse' && payload.error
        || event === 'Stop' && (payload.error || payload.terminationReason !== 'NO_TOOL_CALL'))) this.workerFault = true;
      if (!this.continuityUnsafe && (this.chat?.liveManagement
        || this.options.worker && this.commands?.observedBackgroundCommand
        || event === 'PreToolUse' && decision.decision === 'deny' && !idleDecision
        || controls.some(row => creationReceipt(row, payload.conversationId as string, row.step_index)))) {
        this.continuityUnsafe = true;
        this.options.settledPrompt?.(false);
      }
      if (this.active && decision.decision !== 'deny') {
        if (event === 'PreToolUse') {
          const call = payload.toolCall as { id: string; name: string; args: Record<string, unknown> };
          if (call && Number.isSafeInteger(payload.stepIdx)) {
            if (decision.decision === 'allow') {
              this.commands?.observeTool(payload.stepIdx as number, call.name, call.id, call.args, this.options.cwd,
                !!this.sessionId && this.active.hostScheduleSessionId === this.sessionId && this.hostScheduleSafe);
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
          if (step === this.commands?.pendingStatusStep || this.blocked) continue;
          const row = rows.find(row => row.step_index === step && row.type === 'GENERIC' && row.status === 'DONE');
          if (row) { this.active.onToolResult?.({ tool_use_id: id, content: (row.content ?? '').slice(0, 32768), is_error: event === 'PostToolUse' && !!payload.error }); this.tools.delete(step); }
        }
      }
      if (event === 'Stop') this.humanQueryAdmission = undefined;
      if (event === 'PreInvocation' && !this.blocked && !decision.terminationBehavior) this.humanQueryAdmission?.open?.();
      this.reportCommandState();
      return idleDecision?.terminationBehavior && !this.blocked ? idleDecision : decision;
    }, () => {
      this.relayFault = true;
      this.chat?.fence('AGY hook relay failed; chat state is unconfirmed.');
      this.host?.schedules.fence('AGY hook relay failed; native schedule state is unconfirmed.');
      this.answerQuestion?.(undefined);
    });
    this.restore = await installAgyScheduleHooks(this.options.home, await this.relay.start());
    if (this.closing) throw new Error('AGY startup was retired.');
    if (this.options.consumeManualConfirmation) this.restore.run(this.options.consumeManualConfirmation);
    // Consume a clean checkpoint under the per-HOME kernel gate, before spawning.
    let restoredErrors: ReturnType<typeof restoreAgyToolErrors> | undefined;
    const idleHistory = this.options.commandCheckpoint?.idleDenialHistory;
    const verifiedHistory = this.options.verifiedHistory;
    let checkpointBound = false;
    if (this.options.toolErrorDigest !== undefined || idleHistory !== undefined || verifiedHistory !== undefined) {
      if (!this.options.validatedChatLoad || !this.options.sessionId || this.options.worker || !this.options.hostScheduleChat) {
        throw new Error('AGY tool checkpoint requires the original main conversation.');
      }
      this.relay.bindSession(this.options.sessionId);
      checkpointBound = true;
      let rows = await this.relay.readCheckpointTranscript();
      // Revalidate the recovered prefix in this process. Later evidence is
      // restored relative to the same live control boundary as its retired host.
      if (verifiedHistory !== undefined) {
        this.recoveredHistory = restoreAgyVerifiedHistory(rows, verifiedHistory);
        rows = rows.slice(verifiedHistory.count);
      }
      if (idleHistory !== undefined) {
        this.commands = new AgyCommandTasks(this.options.sessionId, this.options.home, this.options.commandCheckpoint);
        rows = this.commands.restoreHistory(rows);
      }
      if (this.options.toolErrorDigest !== undefined) restoredErrors = restoreAgyToolErrors(rows, this.options.toolErrorDigest);
    }
    if (this.options.sessionId) {
      this.options.beforeSessionLoad?.();
      if (this.options.claimWorkerLoad) this.restore.run(this.options.claimWorkerLoad);
    }
    const args = ['acp', '--stdio', '--process-per-session', '--disable-telemetry'];
    if (this.options.autoApprove) args.push('--dangerously-skip-permissions');
    setStage('process');
    this.client = this.restore.run(() => new AcpClient(this.options.command, args, this.options.cwd, this.callbacks, true,
      { env: this.options.env, delegationWorker: true, onStderr: () => {} }));
    setStage('initialize');
    const agent = (await this.client.initialize() as { agentInfo?: { version?: unknown } } | undefined)?.agentInfo;
    this.nativeVersion = typeof agent?.version === 'string' ? agent.version : undefined;
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
      if (this.options.beforeManualLoad) {
        const rows = await this.relay.readCheckpointTranscript(this.options.sessionId);
        this.recoveredHistory = { count: rows.length, lastStep: rows.at(-1)?.step_index ?? -1, digest: agyHistoryDigest(rows) };
        this.restore.run(this.options.beforeManualLoad);
      }
      if (this.options.workerHistory) {
        const rows = await this.relay.readCheckpointTranscript(this.options.sessionId);
        if (!this.options.worker || !workerHistoryPrefix(rows, this.options.workerHistory)) {
          throw new Error('The aborted AGY worker history changed before load.');
        }
        // Late cancellation notifications can arrive with the next user input. A
        // verified old creation permits consuming its notice exactly once. It
        // never registers the command as outstanding on the new process.
        const prefix = rows.slice(0, this.options.workerHistory.count);
        this.commands = new AgyCommandTasks(this.options.sessionId, this.options.home);
        for (const row of prefix) {
          if (row.status === 'RUNNING' && receiptText(row)?.startsWith('Tool is running as a background task with task id: '
            + this.options.sessionId + '/task-' + row.step_index + '\n')) this.retiredWorkerCommands.add(row.step_index);
          const finished = this.commands.retiredCommandExit(row, this.retiredWorkerCommands);
          if (finished !== undefined) this.retiredWorkerCommands.delete(finished);
        }
      }
      if (this.options.verifyWorkerLoad) this.restore.run(this.options.verifyWorkerLoad);
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
      this.chat = new AgyChatHost(this.client, session.sessionId, this.options.cwd, this.options.threadId, [], restoredErrors, this.nativeVersion);
      if (this.options.hostScheduleChat || this.options.worker) {
        this.commands ??= new AgyCommandTasks(session.sessionId, this.options.home, this.options.commandCheckpoint);
      }
      if (!checkpointBound) this.relay.bindSession(session.sessionId);
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
      if (!this.closing) {
        this.idleChatExited = !!this.chat && !!this.options.hostScheduleChat && !this.options.worker
          && !this.busy && !this.relayFault && !this.permissionDeclined && !this.commands?.pending && !this.retained
          && (this.chat.humanContinuation || this.hostScheduleSettled && this.checkpointEligible);
        this.host?.schedules.processClosed(false);
        this.chat?.fence('AGY process closed unexpectedly.');
      }
    });
  }

  async execute(prompt: string, options: ExecuteOptions, confirmHuman?: () => void,
    questionAuth?: RecoveryQuestionAuthority): Promise<ExecuteResult> {
    await this.start();
    if (this.workerAbort) throw new Error('The aborted AGY worker requires confirmed retirement.');
    if (this.active || this.settingsBusy) throw new Error('AGY foreground turn is already active.');
    if (confirmHuman && (options.hostScheduleSessionId !== undefined || !this.needsHumanContinuation)) {
      throw new Error('The AGY foreground is no longer eligible for human continuation.');
    }
    if (this.commands?.pending) {
      if (this.blocked) throw new Error(this.blocked);
      throw new Error(this.commands.outstandingCount ? 'AGY command completion is pending.' : 'AGY command completion is pending. Waiting for the notification Stop.');
    }
    if (this.chat && !this.chat.reusable && this.permissionDeclined) throw new Error('AGY permission outcome prevents continuation.');
    this.active = options; this.permissionDeclined = false; this.streamed = ''; this.tools.clear(); this.tracker.setCallback(options.onActivity); this.tracker.reset();
    this.hostScheduleSettled = false;
    this.questionAuth = questionAuth;
    if (options.hostScheduleSessionId !== undefined && options.onUnattendedInputRequired) {
      let reported = false;
      this.unattendedInput = () => {
        if (reported) return;
        reported = true;
        options.onUnattendedInputRequired?.();
      };
    }
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
      if (confirmHuman) this.restore!.run(confirmHuman);
      this.prompted = true;
      const dispatch = (input: AcpContentBlock[]) => {
        const onAdmitted = options.onAgyHumanPromptAdmitted;
        if (onAdmitted && (this.manualTurnPending || confirmHuman) && !this.options.worker && options.hostScheduleSessionId === undefined) {
          // Arm only at dispatch. The authenticated PreInvocation opens this turn's
          // read scope once, and Stop or cancellation invalidates its identity.
          const grant: NonNullable<typeof this.humanQueryAdmission> = {};
          grant.open = () => {
            grant.open = undefined;
            onAdmitted(() => this.humanQueryAdmission === grant && this.active === options && !this.blocked
              && !this.closing && !this.closed && !this.relayFault && !this.permissionDeclined);
          };
          this.humanQueryAdmission = grant;
        }
        return this.promptWithQuestions(input);
      };
      this.ordinaryMain = !this.options.worker && options.hostScheduleSessionId === undefined
        && (!this.options.managedCoordinator || options.agyHumanMessage || this.manualTurnPending || !!confirmHuman);
      const admission = confirmHuman ? 'confirmed-human' : this.ordinaryMain ? 'main' : 'strict';
      const work = this.chat ? this.chat.prompt(blocks, dispatch, admission) : this.host!.prompt(blocks, dispatch);
      const result = await work;
      if (this.options.worker && this.commands?.observedBackgroundCommand) {
        // The current turn can consume its own command exit. Its history still
        // contains the native RUNNING row and cannot authorize another worker.
        this.chat!.fence('AGY worker observed a background command; this conversation is not reusable.');
        if (result.success && result.stopReason !== 'end_turn') throw new Error('AGY worker command turn did not complete.');
      }
      if (result.stopReason === 'cancelled' && !this.retained && !this.relayFault && !this.continuityUnsafe && !this.chat
        && this.host?.schedules.status.blocked?.startsWith('AGY foreground cancelled:')) {
        this.chat = new AgyChatHost(this.client!, this.sessionId!, this.options.cwd, this.options.threadId, this.latestRecords, [], this.nativeVersion);
        this.host = undefined;
      }
      this.options.settledPrompt?.(this.reusable && result.stopReason !== 'cancelled'
        && (!this.options.worker || result.success && result.stopReason === 'end_turn'));
      const completed = result.success && result.stopReason === 'end_turn';
      if (this.manualTurnPending) {
        if (!completed) return { success: false, error: result.output || 'AGY recovery turn did not complete.', output: result.output };
        this.manualTurnPending = false;
        // An already delivered foreign message belongs to the confirmed turn. Keep
        // timers fenced and distinguish that exact history from a new arrival.
        if (this.idleStop) {
          for (const row of this.latestRecords) {
            if (foreignMessage(row) && !nativeWake(row)) this.acceptedMessages.set(row.step_index, structuredClone(row));
          }
        }
        // Only settled terminal history can re-enable bound host timers after manual admission.
        if (!this.idleStop || !this.verifiedRecovery()) this.hostScheduleUnsafe = true;
      }
      this.hostScheduleSettled = completed && this.foregroundReusable;
      // Confirmed foreground command management keeps ordinary chat live. continuityUnsafe already
      // disqualifies this host from scheduling, reconnect and durable checkpoints.
      if (!this.hostScheduleSettled && !(completed && this.chat?.liveManagement && this.chat.reusable)) this.hostScheduleUnsafe = true;
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
      this.permissions.cancel(); this.answerQuestion?.(undefined); this.question = undefined; this.questionAuth = undefined; this.unattendedInput = undefined;
      this.tracker.reset(); this.tracker.setCallback(undefined); this.activity = undefined; this.active = undefined; this.tools.clear();
      this.humanQueryAdmission = undefined;
      this.ordinaryMain = false;
      this.commands?.endForeground();
    }
  }
  /** The unchanged historical prefix and the hook-observed recovery suffix must
   * both consist of settled synchronous calls; foreign or wake rows stay fenced. */
  private verifiedRecovery(): boolean {
    const history = this.recoveredHistory, rows = this.latestRecords;
    if (!history || rows.length <= history.count) return false;
    const prefix = rows.slice(0, history.count), suffix = rows.slice(history.count);
    if (agyHistoryDigest(prefix) !== history.digest) return false;
    try {
      verifyAgyTerminalHistory(prefix);
      verifyAgyTerminalHistory(suffix, history.count, true);
    } catch { return false; }
    return true;
  }
  private async promptWithQuestions(blocks: AcpContentBlock[]): Promise<{ stopReason: string }> {
    for (;;) {
      const question: NonNullable<AgyAcpRuntime['question']> = this.question = {};
      this.workerInFlight = !!this.options.worker;
      let terminal;
      try {
        terminal = await this.client!.prompt(this.sessionId!, blocks);
        if (this.workerAbort) this.workerAbort.confirmed = terminal.stopReason === 'cancelled';
      } finally { this.workerInFlight = false; }
      if (terminal.stopReason !== 'end_turn' || !question.pendingCall || !question.args || this.blocked || this.closing
        || !(this.chat ?? this.host!.schedules).suspendForeground()) return terminal;
      if (this.questionAuth && !this.questionAuth.routeCurrent()) {
        this.continuityUnsafe = true;
        this.chat?.fence('AGY recovery question route changed before input.');
        return { stopReason: 'cancelled' };
      }
      // ACP settles its request while the hook invocation remains open.
      // The next native prompt on this session resumes that invocation.
      this.activity?.();
      let source: AgyHumanConfirmation | undefined;
      const answer = await new Promise<string | undefined>(resolve => {
        this.answerQuestion = (value, confirmation) => {
          this.answerQuestion = undefined;
          source = confirmation;
          resolve(value);
        };
        const questions = this.retained && Array.isArray(question.args?.questions) ? question.args.questions : [];
        const text = questions.flatMap(item => typeof item?.question === 'string' && Array.isArray(item.options)
          ? [item.question, ...item.options.filter((option: unknown) => typeof option === 'string')
            .map((option: string, index: number) => `- [${index + 1}] ${option}`)] : []).join('\n');
        const message = `\n${text ? text + '\n' : ''}Reply in this thread to continue.\n`;
        this.active?.onStream?.(message);
        if (text) this.active?.onDisplayText?.(text);
      });
      if (answer === undefined || this.closing || this.blocked) return { stopReason: 'cancelled' };
      if (this.questionAuth) {
        const auth = this.questionAuth;
        const confirmation = source;
        if (!confirmation) throw new Error('Missing AGY recovery answer confirmation.');
        this.restore!.run(() => auth.check(confirmation));
      }
      this.activity?.();
      blocks = [{ type: 'text', text: answer }];
    }
  }
  async abort(reason?: 'cancelled' | 'timed_out'): Promise<boolean> {
    // Only an explicit executor abort can arm worker continuity. Local deadlines
    // use cancelForeground directly. A prompt must already have reached native hooks.
    const prefix = reason !== 'timed_out' && !this.workerAbort && this.options.worker && this.workerInFlight && this.chat?.hasForegroundToolCoverage(this.latestRecords)
      && !this.closing && !this.blocked && !this.workerFault && !this.relayFault && !this.permissionDeclined
      && !this.isWaitingInput() && this.commands
      ? workerAbortBoundary(this.latestRecords, this.commands, this.options.workerHistory, this.acceptedMessages) : undefined;
    if (prefix) this.workerAbort = { prefix, confirmed: false };
    this.permissions.cancel();
    try {
      const sent = this.cancelForeground();
      if (!sent && prefix) this.workerAbort = undefined;
      return sent;
    } catch (error) {
      if (prefix) this.workerAbort = undefined;
      throw error;
    }
  }
  private cancelForeground(): boolean {
    this.humanQueryAdmission = undefined;
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
  get requiresAuthenticatedInput(): boolean { return this.isWaitingInput() && (!!this.questionAuth || this.manualTurnPending); }
  cancelRecoveredInput(): void {
    if (this.requiresAuthenticatedInput) { this.permissions.cancel(); this.cancelForeground(); }
  }
  sendInput(input: string, confirmation?: AgyHumanConfirmation): boolean {
    if (!this.isWaitingInput() || !input.trim()) return false;
    if (this.questionAuth || this.manualTurnPending) {
      if (!this.questionAuth || !confirmation) return false;
      if (!this.questionAuth.routeCurrent()) {
        this.cancelForeground();
        return false;
      }
      try {
        this.restore!.run(() => this.questionAuth!.consume(confirmation));
      } catch {
        return false;
      }
    }
    if (!this.answerQuestion) return this.permissions.input(input);
    this.answerQuestion(input, confirmation);
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
      if (!this.chat) this.chat = new AgyChatHost(this.client!, this.sessionId!, this.options.cwd, this.options.threadId, this.latestRecords, [], this.nativeVersion);
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
    if (!this.closing && this.workerAbort && this.workerInFlight) this.workerAbort.confirmed = true;
    this.closing = true; this.permissions.cancel(); this.answerQuestion?.(undefined);
    return this.closePromise ??= (async () => {
      await this.starting?.catch(() => {});
      await this.finishClose();
    })().catch(error => { this.closePromise = undefined; throw error; });
  }
  private async finishClose(): Promise<void> {
    this.closing = true;
    if (this.host) await this.host.close();
    else if (!this.idleChatExited) { this.client?.destroy(); await this.client?.waitForExit?.(); }
    if (this.client && !this.client.waitForManagedProcessGroupExit) throw new Error('AGY exact process-group retirement cannot be confirmed.');
    await this.client?.waitForManagedProcessGroupExit?.();
    if (this.host) {
      if (this.retained) this.options.retainScheduleOwner(this.host.sessionId, this.hostId, true);
      this.host.schedules.processClosed(true);
    }
    let cleanHistory: string | undefined;
    let unpromptedHistory: string | undefined;
    if (!this.manualTurnPending && this.options.hostScheduleChat && !this.hostScheduleUnsafe && !this.relayFault && this.checkpointEligible && this.sessionId && this.relay) {
      try {
        if (this.hostScheduleSettled) {
          const history = agyHostScheduleHistory(this.options.home, this.sessionId);
          if (await this.relay.confirmsTerminal(this.latestRecords)) cleanHistory = history;
        } else if (!this.prompted && !this.latestRecords.length) {
          unpromptedHistory = agyHostScheduleHistory(this.options.home, this.sessionId, true);
        }
      } catch { /* Missing history withholds checkpoint admission after an otherwise confirmed exit. */ }
    }
    let workerPrefix: AgyVerifiedHistory | undefined;
    if (this.workerAbort?.confirmed && !this.workerFault && !this.permissionDeclined && !this.relayFault && this.relay && this.commands) {
      try {
        const rows = await this.relay.readCheckpointTranscript();
        workerPrefix = retiredWorkerHistory(rows, this.workerAbort.prefix, this.commands);
      } catch { /* Absent or ambiguous history cannot establish worker continuity. */ }
    }
    if (!this.workerAbort && this.options.workerHistory && this.reusable && await this.relay?.confirmsTerminal(this.latestRecords)) {
      workerPrefix = workerBoundary(this.latestRecords);
    }
    await this.relay?.close();
    try {
      if (this.options.worker && this.chat && this.restore) {
        if (!this.reusable || this.workerFault) this.options.settledPrompt?.(false);
        this.restore.run(() => this.options.workerClosed?.(this.relayFault || this.workerFault ? undefined : workerPrefix,
          !!this.workerAbort && !!workerPrefix));
      }
    } finally { await this.restore?.(); this.restore = undefined; }
    if (!this.options.worker && !this.reusable) this.options.settledPrompt?.(false);
    if (this.host || this.chat) {
      const safe = !this.hostScheduleUnsafe && !this.relayFault && this.checkpointEligible;
      const errors = safe && cleanHistory ? this.chat?.checkpointToolErrors() : undefined;
      // Command and tool evidence after a verified prefix is bound to the live control rows only.
      const verified = safe && cleanHistory ? this.recoveredHistory : undefined;
      this.options.ownedSessionClosed(this.sessionId!, safe ? cleanHistory : undefined, safe ? unpromptedHistory : undefined,
        safe && cleanHistory ? this.commands?.snapshot(this.latestRecords.slice(verified?.count ?? 0)) : undefined,
        ...(errors || verified ? [errors] : []), ...(verified ? [{ ...verified }] : []));
    }
    this.closed = true;

  }
}
