import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { DirectoryGuard } from '../security/DirectoryGuard';
import type { Attachment, ApprovalAction, ApprovalStatus, ApprovalRequestInfo } from '../types';
import type { ExecuteOptions, ExecuteResult, ExecutorGoal, ExecutorGoalRunRequest, ExecutorModelInfo, ExecutorEffortInfo, ExecutorSpeedInfo, IExecutor } from './IExecutor';
import { assertNativeGoalsVersion, nativeGoalError, parseNativeGoal, validateGoalRequest } from './codex/CodexGoals';
import { CodexImages, codexToolResultText } from './codex/CodexImages';
import { configuredExecutionMetadata } from './ExecutionMetadata';
import { AppServerMessage, CodexAppServerClient } from './CodexAppServerClient';
import { CodexTaskNotifications } from './CodexTaskNotifications';
import { CodexSandbox } from './CodexSandbox';
import type { CodexSandboxConfig } from '../types/config';
import { DELEGATION_TOOLS, delegationMcpConfig, sameConnection, type DelegationConnection } from '../delegation/contract';
import { assertWorkingDirectoryExists } from '../utils/WorkingDirectory';
import { ActivityTracker, extractTodoPlan, sanitizeActivityText } from './Activity';
import { describeCodexCommandActions } from './CodexCommandActions';
import { codexWebSearchUse, codexWebSearchResult } from './CodexWebSearch';

export interface CodexAppServerTransport {
  start(): Promise<void>;
  request(method: string, params?: any, timeoutMs?: number): Promise<any>;
  respond(id: number | string, result: any): void;
  respondError(id: number | string, message: string, code?: number): void;
  onMessage(handler: (message: AppServerMessage) => void): () => void;
  stop(): Promise<void>;
  waitForExit?(): Promise<void>;
  waitForManagedProcessGroupExit?(): Promise<void>;
  isRunning(): boolean;
  setWorkingDirectory(cwd: string): void;
  getServerVersion?(): string | null;
  getCommandVersion?(): Promise<string | null>;
}

export interface CodexAppServerExecutorOptions {
  model?: string;
  effort?: string;
  speed?: string | null;
  autoApprove?: boolean;
  sandbox?: CodexSandboxConfig;
  initialWorkingDirectory?: string;
  codexCommand?: string;
  threadId?: string;
  delegationWorker?: boolean;
  inactivityTimeoutMs?: number;
  compactTimeoutMs?: number;
  clientFactory?: (cwd: string) => CodexAppServerTransport;
}

interface ActiveTurn {
  options: ExecuteOptions;
  resolve: (result: ExecuteResult) => void;
  turnId: string | null;
  output: string[];
  error?: string;
  errorCode?: string;
  sideEffectsStarted: boolean;
  emittedTools: Map<string, { title?: string; description?: string; fallback?: boolean; completed?: boolean }>;
  itemPhases: Map<string, string>;
  temporaryFiles: string[];
  images: CodexImages;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  inactivityTimeoutMs?: number;
}

interface CompactWaiter {
  resolve: (result: ExecuteResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface GoalRun {
  active: ActiveTurn;
  done: Promise<ExecuteResult>;
  startup?: Promise<void>;
  goal?: ExecutorGoal | null;
  objective?: string;
  ready: boolean;
  inFlight: Set<string>;
  retired: Set<string>;
  revision: number;
  checking: boolean;
  controlling: boolean;
  stopping: boolean;
  lastNotice?: string;
  onIdle?: () => void;
}

interface PendingUserInput {
  id: number | string;
  method: string;
  params: any;
  approval?: ApprovalRequestInfo;
  resolved?: ExecuteOptions['onApprovalResolved'];
}

const DEFAULT_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_COMPACT_TIMEOUT_MS = 10 * 60 * 1000;
const ACCOUNT_USAGE_TIMEOUT_MS = 10_000;
const GOAL_CONTROL_TIMEOUT_MS = 10_000;
const GOAL_RECOVERY_GUIDANCE = 'Use /goal resume to continue the saved native goal, or /goal pause or /goal clear before sending another task.';

interface CodexRateLimitWindow {
  usedPercent?: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

interface CodexRateLimitSnapshot {
  limitName?: string | null;
  planType?: string | null;
  primary?: CodexRateLimitWindow | null;
  secondary?: CodexRateLimitWindow | null;
  credits?: { balance?: string | null; hasCredits?: boolean; unlimited?: boolean } | null;
  individualLimit?: { limit?: string; used?: string; remainingPercent?: number; resetsAt?: number } | null;
  rateLimitReachedType?: string | null;
}

function formatWindowDuration(minutes?: number | null): string {
  if (!Number.isFinite(minutes) || !minutes || minutes <= 0) return 'usage window';
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}-day window`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour window`;
  return `${minutes}-minute window`;
}

function formatResetTime(seconds?: number | null): string {
  if (!Number.isFinite(seconds) || !seconds || seconds <= 0) return '';
  return `, resets ${new Date(seconds * 1000).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  })}`;
}

function formatCodexAccountUsage(response: any): string | null {
  const byId = response?.rateLimitsByLimitId;
  const snapshots: Array<{ id?: string; value: CodexRateLimitSnapshot }> = byId
    && typeof byId === 'object'
    && Object.keys(byId).length > 0
    ? Object.entries(byId).map(([id, value]) => ({ id, value: value as CodexRateLimitSnapshot }))
    : response?.rateLimits && typeof response.rateLimits === 'object'
      ? [{ value: response.rateLimits as CodexRateLimitSnapshot }]
      : [];
  const lines: string[] = [];

  for (const { id, value } of snapshots) {
    const label = value.limitName || id;
    const prefix = snapshots.length > 1 && label ? `${label}: ` : '';
    if (value.primary && typeof value.primary.usedPercent === 'number') {
      const remaining = Math.max(0, Math.min(100, 100 - value.primary.usedPercent));
      lines.push(`- ${prefix}${formatWindowDuration(value.primary.windowDurationMins)}: ${remaining}% remaining${formatResetTime(value.primary.resetsAt)}`);
    }
    if (value.secondary && typeof value.secondary.usedPercent === 'number') {
      const remaining = Math.max(0, Math.min(100, 100 - value.secondary.usedPercent));
      lines.push(`- ${prefix}${formatWindowDuration(value.secondary.windowDurationMins)}: ${remaining}% remaining${formatResetTime(value.secondary.resetsAt)}`);
    }
    if (value.credits?.unlimited) {
      lines.push(`- ${prefix}Credits: unlimited`);
    } else if (value.credits?.balance != null) {
      lines.push(`- ${prefix}Credits: ${value.credits.balance}`);
    } else if (value.credits && value.credits.hasCredits === false) {
      lines.push(`- ${prefix}Credits: none remaining`);
    }
    if (value.individualLimit && typeof value.individualLimit.remainingPercent === 'number') {
      const detail = value.individualLimit.used != null && value.individualLimit.limit != null
        ? ` (${value.individualLimit.used} of ${value.individualLimit.limit} used)`
        : '';
      lines.push(`- ${prefix}Spend limit: ${value.individualLimit.remainingPercent}% remaining${detail}${formatResetTime(value.individualLimit.resetsAt)}`);
    }
    if (value.rateLimitReachedType) {
      lines.push(`- ${prefix}Status: ${value.rateLimitReachedType.replaceAll('_', ' ')}`);
    }
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

/**
 * Persistent Codex executor backed by the official app-server protocol.
 * One instance is owned by one remote-cli thread, preserving the existing
 * ThreadExecutorPool isolation model.
 */
export class CodexAppServerExecutor implements IExecutor {
  private readonly directoryGuard: DirectoryGuard;
  private currentWorkingDirectory: string;
  private model?: string;
  private effort?: string;
  private speed?: string | null;
  /** Only a fresh legacy thread is known not to carry an older remote speed override. */
  private legacyFollowReady = false;
  private reportedModel?: string;
  private reportedEffort?: string;
  private readonly autoApprove: boolean;
  private readonly sandbox: CodexSandbox;
  private readonly remoteThreadId?: string;
  private readonly sessionFilePath: string;
  private readonly inactivityTimeoutMs: number;
  private readonly compactTimeoutMs: number;
  private readonly client: CodexAppServerTransport;
  private readonly taskNotifications: CodexTaskNotifications;
  private readonly activityTracker = new ActivityTracker();
  private unsubscribeClient: (() => void) | null = null;

  private codexThreadId: string | null = null;
  private threadReady = false;
  private activeTurn: ActiveTurn | null = null;
  private compactWaiter: CompactWaiter | null = null;
  private transportStop: Promise<void> | null = null;
  private pendingUserInputs: PendingUserInput[] = [];
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private delegation?: DelegationConnection;
  private delegationConfigured = false;
  private readonly delegationWorker: boolean;
  private sessionResumeFailure = false;
  private goalManaged = false;
  private goalNeedsResume = false;
  private goalRun: GoalRun | null = null;
  private goalControl: Promise<ExecuteResult> | null = null;
  private goalControlClear = false;
  private goalTransportStops = 0;
  private threadLoads = 0;

  async configureDelegation(connection?: DelegationConnection): Promise<void> {
    if (this.delegationConfigured && sameConnection(this.delegation, connection)) return;
    if (this.isBusy()) throw new Error('Cannot change delegation while Codex is busy');
    await this.client.stop();
    this.threadReady = false;
    this.delegation = connection;
    this.delegationConfigured = true;
  }

  constructor(directoryGuard: DirectoryGuard, options: CodexAppServerExecutorOptions = {}) {
    this.directoryGuard = directoryGuard;
    this.model = options.model;
    this.speed = options.speed;
    this.effort = options.effort;
    this.autoApprove = options.autoApprove ?? true;
    this.remoteThreadId = options.threadId;
    this.delegationWorker = options.delegationWorker ?? false;
    this.sandbox = new CodexSandbox(directoryGuard, options.sandbox, options.threadId);
    this.inactivityTimeoutMs = options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;
    this.compactTimeoutMs = options.compactTimeoutMs ?? DEFAULT_COMPACT_TIMEOUT_MS;

    if (options.initialWorkingDirectory) {
      try {
        this.currentWorkingDirectory = directoryGuard.resolveWorkingDirectory(options.initialWorkingDirectory);
      } catch (error) {
        console.warn(`[CodexAppServerExecutor] Failed to use initial working directory: ${options.initialWorkingDirectory}`, error);
        this.currentWorkingDirectory = process.cwd();
      }
    } else {
      this.currentWorkingDirectory = process.cwd();
    }

    if (this.remoteThreadId) {
      const sessionsDir = path.join(process.env.HOME || os.homedir(), '.remote-cli', 'codex-sessions');
      fs.mkdirSync(sessionsDir, { recursive: true });
      this.sessionFilePath = path.join(sessionsDir, `${this.remoteThreadId}.json`);
    } else {
      this.sessionFilePath = path.join(this.currentWorkingDirectory, '.codex-session');
    }
    this.loadThreadId();

    this.client = options.clientFactory
      ? options.clientFactory(this.currentWorkingDirectory)
      : new CodexAppServerClient({
          command: options.codexCommand,
          cwd: this.currentWorkingDirectory,
          delegationWorker: this.delegationWorker,
        });
    this.taskNotifications = new CodexTaskNotifications((method, params) => this.client.request(method, params));
    this.unsubscribeClient = this.client.onMessage((message) => this.handleMessage(message));
  }

  async execute(prompt: string, options: ExecuteOptions = {}): Promise<ExecuteResult> {
    this.sessionResumeFailure = false;
    if (this.destroyed) throw new Error('Executor has been destroyed');
    if (this.isBusy()) {
      return { success: false, error: 'Codex thread is already running a command' };
    }

    try {
      await this.ensureThread();
      if (this.isBusy()) return { success: false, error: 'Codex thread is already running a command' };
    } catch (error) {
      return { success: false, error: this.errorMessage(error) };
    }

    const temporaryFiles: string[] = [];
    try {
      // Resolve paths before marking a turn active so a rejected policy cannot
      // leave the executor busy without an actual app-server turn.
      const sandboxOptions = this.sandbox.turnOptions(this.currentWorkingDirectory);
      const input = await this.buildInput(prompt, options.attachments, temporaryFiles);
      const speedOptions = await this.speedOptions();
      if (this.isBusy()) {
        await this.cleanupTemporaryFiles(temporaryFiles);
        return { success: false, error: 'Codex thread is already running a command' };
      }
      return await new Promise<ExecuteResult>((resolve) => {
        const active: ActiveTurn = {
          options,
          resolve,
          turnId: null,
          output: [],
          sideEffectsStarted: false,
          emittedTools: new Map(),
          itemPhases: new Map(),
          temporaryFiles,
          images: new CodexImages(),
          inactivityTimeoutMs: options.inactivityTimeout,
        };
        this.activityTracker.setCallback(options.onActivity);
        this.activityTracker.reset();
        if (options.timeout && options.timeout > 0) {
          active.timeoutTimer = setTimeout(() => {
            void this.failAndRestart(`Command timed out after ${options.timeout}ms`);
          }, options.timeout);
        }
        this.activeTurn = active;
        this.armInactivityTimer();

        const params: any = {
          threadId: this.codexThreadId,
          input,
          cwd: this.currentWorkingDirectory,
          ...(this.model ? { model: this.model } : {}),
          ...(this.effort ? { effort: this.effort } : {}),
          ...speedOptions,
          ...(this.autoApprove ? {
            approvalPolicy: 'never',
            sandboxPolicy: { type: 'dangerFullAccess' },
          } : {}),
          ...sandboxOptions,
        };

        void this.client.request('turn/start', params).then((response) => {
          if (this.activeTurn !== active) return;
          this.captureReportedSettings(response);
          const turnId = response?.turn?.id;
          if (typeof turnId !== 'string' || !turnId) {
            void this.failAndRestart('Codex app-server returned no turn ID');
            return;
          }
          active.turnId = turnId;
        }).catch((error) => {
          if (this.activeTurn === active) {
            void this.failAndRestart(this.errorMessage(error));
          }
        });
      });
    } catch (error) {
      await this.cleanupTemporaryFiles(temporaryFiles);
      return { success: false, error: this.errorMessage(error) };
    }
  }

  getCurrentWorkingDirectory(): string {
    return this.currentWorkingDirectory;
  }

  isGoalRunning(): boolean {
    return this.goalRun !== null;
  }

  /** Reading a saved goal must never materialize or resume its native thread. */
  async getGoal(): Promise<ExecutorGoal | null> {
    if (this.destroyed) throw new Error('Executor has been destroyed');
    if (!this.codexThreadId) return null;
    const threadId = this.codexThreadId;
    try {
      await this.goalDeadline(this.client.start());
      assertNativeGoalsVersion(this.client.getServerVersion?.());
      const response = await this.goalRequest('thread/goal/get', { threadId });
      if (this.codexThreadId !== threadId || this.destroyed) throw new Error('The native goal session changed while reading it.');
      const goal = parseNativeGoal(response?.goal, threadId);
      if (goal && !this.goalManaged) this.rememberGoalManagement();
      return goal;
    } catch (error) { throw new Error(nativeGoalError(error)); }
  }

  async executeGoal(request: ExecutorGoalRunRequest, options: ExecuteOptions): Promise<ExecuteResult> {
    try {
      validateGoalRequest(request);
      if (this.destroyed) throw new Error('Executor has been destroyed');
      if (this.isBusy()) throw new Error('Codex thread is already running a command');
      if (this.delegationWorker || this.delegation) throw new Error('Native goals require managed delegation to be off and cannot run in a delegated worker.');
      if (request.objective === undefined && !this.codexThreadId) throw new Error('There is no saved native goal to resume.');
    } catch (error) { return { success: false, error: nativeGoalError(error) }; }

    let resolve!: (result: ExecuteResult) => void;
    const done = new Promise<ExecuteResult>(settle => { resolve = settle; });
    const active: ActiveTurn = { options, resolve, turnId: null, output: [], sideEffectsStarted: false,
      emittedTools: new Map(), itemPhases: new Map(), temporaryFiles: [], images: new CodexImages(), inactivityTimeoutMs: options.inactivityTimeout };
    const run: GoalRun = { active, done, objective: request.objective, ready: false, inFlight: new Set(), retired: new Set(),
      revision: 0, checking: false, controlling: false, stopping: false };
    // Install ownership before any native loading or mutation can start a turn.
    this.goalRun = run;
    this.activeTurn = active;
    this.activityTracker.setCallback(options.onActivity);
    this.activityTracker.reset();
    this.armInactivityTimer();
    if (options.timeout && options.timeout > 0) active.timeoutTimer = setTimeout(() => {
      void this.failGoal(run, `Native goal timed out after ${options.timeout}ms. ${GOAL_RECOVERY_GUIDANCE}`);
    }, options.timeout);
    run.startup = this.startGoal(run, request).catch(error => this.failGoal(run, nativeGoalError(error)));
    return done;
  }

  pauseGoal(): Promise<ExecuteResult> {
    return this.controlGoal(false);
  }

  clearGoal(): Promise<ExecuteResult> {
    return this.controlGoal(true);
  }

  private async startGoal(run: GoalRun, request: ExecutorGoalRunRequest): Promise<void> {
    await this.goalDeadline(this.client.start());
    this.assertGoalOwner(run);
    assertNativeGoalsVersion(this.client.getServerVersion?.());
    let previous: ExecutorGoal | null = null;
    if (this.codexThreadId) {
      previous = await this.getGoal();
      this.assertGoalOwner(run);
    }
    if (request.objective === undefined && (!previous || previous.status === 'complete')) {
      throw new Error('There is no unfinished native goal to resume.');
    }
    // Replacing an active saved goal must not briefly execute its old objective on load.
    if (request.objective !== undefined && previous?.status === 'active' && !this.threadReady) {
      throw new Error('Pause or clear the saved active goal before replacing its objective.');
    }
    run.goal = previous;
    run.objective = request.objective ?? previous?.objective;
    this.rememberGoalManagement();
    if (previous?.status === 'active' && !this.threadReady) {
      // Loading an active goal can dispatch before settings/update. Suspend it
      // without loading, then restore activation only after native policy sync.
      const response = await this.goalRequest('thread/goal/set', {
        threadId: this.codexThreadId, status: 'paused', origin: 'user',
      });
      this.assertGoalOwner(run);
      const paused = parseNativeGoal(response?.goal, this.codexThreadId!);
      if (!paused || paused.status !== 'paused') throw new Error('Codex did not pause the saved goal before loading its policies.');
      run.goal = paused;
      if (run.controlling) return;
    }
    await this.ensureThread();
    this.assertGoalOwner(run);
    this.rememberGoalManagement();
    if (run.controlling) return;
    // Native continuations bypass turn/start, so their settings must be sticky.
    const goalPolicy = this.sandbox.turnOptions(this.currentWorkingDirectory);
    if (this.model || this.effort || this.speed !== undefined || Object.keys(goalPolicy).length) {
      const speedOptions = await this.speedOptions();
      this.assertGoalOwner(run);
      if (run.controlling) return;
      await this.goalRequest('thread/settings/update', { threadId: this.codexThreadId,
        ...(this.model ? { model: this.model } : {}), ...(this.effort ? { effort: this.effort } : {}),
        ...speedOptions, ...goalPolicy });
      this.assertGoalOwner(run);
      if (run.controlling) return;
    }
    // A resumed active goal may already have completed while the load request ran.
    if (request.objective !== undefined || run.goal?.status !== 'complete') {
      const revision = run.revision;
      const response = await this.goalRequest('thread/goal/set', {
        threadId: this.codexThreadId, origin: 'user',
        ...(request.objective !== undefined ? { objective: request.objective } : {}),
        status: 'active', ...(request.tokenBudget !== undefined ? { tokenBudget: request.tokenBudget } : {}),
      });
      this.assertGoalOwner(run);
      const goal = parseNativeGoal(response?.goal, this.codexThreadId!);
      if (!goal) throw new Error('Codex did not return the activated native goal.');
      if (run.revision === revision) run.goal = goal;
    }
    run.ready = true;
    this.goalNeedsResume = false;
    if (run.goal?.status === 'active') {
      this.goalNotice(run, run.inFlight.size ? 'Native goal running' : 'Native goal active; waiting for native continuation');
    }
    this.maybeCompleteGoal(run);
    if (this.goalRun === run && !run.inFlight.size) void this.checkGoalAfterTurn(run);
  }

  private assertGoalOwner(run: GoalRun): void {
    if (this.goalRun !== run || this.destroyed || run.stopping) throw new Error('Native goal operation was cancelled.');
  }

  private goalNotice(run: GoalRun, text: string): void {
    const bounded = Array.from(text).slice(0, 400).join('');
    if (this.goalRun !== run || run.lastNotice === bounded) return;
    run.lastNotice = bounded;
    try {
      if (run.active.options.onActivity) run.active.options.onActivity({ source: 'state', text: bounded });
      else run.active.options.onStream?.(`\n[${bounded}]\n`);
    } catch { /* A display failure cannot change native goal ownership. */ }
  }

  private maybeCompleteGoal(run: GoalRun): void {
    if (this.goalRun !== run || !run.ready || run.controlling || run.stopping || run.inFlight.size
      || run.goal === undefined || run.goal?.status === 'active') return;
    const status = run.goal?.status ?? 'cleared';
    this.goalNotice(run, `Native goal ${status}`);
    const summary = `\n\nNative goal ${status}.\n`;
    run.active.output.push(summary);
    try { run.active.options.onStream?.(summary); } catch { /* Native completion still releases ownership. */ }
    try { run.active.options.onDisplayText?.(summary); } catch { /* Native completion still releases ownership. */ }
    this.completeActive({ success: status === 'complete' || status === 'paused' || status === 'cleared',
      output: run.active.output.join(''), sessionAbbr: this.codexThreadId?.slice(0, 8),
      ...(['blocked', 'usageLimited', 'budgetLimited'].includes(status) ? { error: `Native goal stopped: ${status}.` } : {}) });
  }

  private async checkGoalAfterTurn(run: GoalRun): Promise<void> {
    if (this.goalRun !== run || run.checking || run.controlling || run.stopping) return;
    run.checking = true;
    const revision = run.revision;
    try {
      const goal = await this.getGoal();
      if (this.goalRun !== run || run.controlling || run.stopping) return;
      if (revision === run.revision) run.goal = goal;
      this.maybeCompleteGoal(run);
    } catch (error) {
      if (this.goalRun === run) await this.failGoal(run, `Could not reconcile native goal: ${nativeGoalError(error)}`);
    } finally { run.checking = false; }
  }

  private goalDeadline<T>(promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Native goal control timed out.')), GOAL_CONTROL_TIMEOUT_MS);
      promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
  }

  private goalRequest(method: string, params: object): Promise<any> {
    if (this.destroyed) return Promise.reject(new Error('Executor has been destroyed'));
    return this.goalDeadline(this.client.request(method, params, GOAL_CONTROL_TIMEOUT_MS));
  }

  private async stopGoalTransport(): Promise<void> {
    this.threadReady = false;
    this.goalNeedsResume = this.goalManaged;
    this.goalTransportStops++;
    try {
      await this.goalDeadline(this.client.stop());
      if (this.client.waitForExit) await this.goalDeadline(this.client.waitForExit());
      else if (this.client.isRunning()) throw new Error('Codex goal process exit could not be confirmed.');
    } finally { this.goalTransportStops--; }
  }

  private async failGoal(run: GoalRun, error: string): Promise<void> {
    if (this.goalRun !== run || run.stopping) return;
    run.stopping = true;
    this.clearInactivityTimer();
    if (run.active.timeoutTimer) clearTimeout(run.active.timeoutTimer);
    try {
      await this.stopGoalTransport();
      if (this.goalRun === run) this.completeActive({ success: false, error });
    } catch (stopError) {
      run.stopping = false;
      this.goalNotice(run, `Native goal stop unconfirmed: ${nativeGoalError(stopError)}. Retry /abort.`);
    }
  }

  private controlGoal(clear: boolean): Promise<ExecuteResult> {
    if (this.goalControl) {
      if (this.goalControlClear === clear) return this.goalControl;
      return this.goalControl.then(result => result.success ? this.controlGoal(clear) : result);
    }
    const control = this.stopGoalControl(this.goalRun, clear);
    this.goalControl = control;
    this.goalControlClear = clear;
    void control.then(() => { if (this.goalControl === control) this.goalControl = null; });
    return control;
  }

  private async stopGoalControl(run: GoalRun | null, clear: boolean): Promise<ExecuteResult> {
    if (this.destroyed) return { success: false, error: 'Executor has been destroyed' };
    if (!run && (this.activeTurn || this.compactWaiter || this.threadLoads)) {
      return { success: false, error: 'Wait for the current ordinary task before changing its goal.' };
    }
    if (!this.codexThreadId && !run) return { success: true, output: 'No native goal is set.' };
    if (run) run.controlling = true;
    try {
      if (run?.startup) await this.goalDeadline(run.startup);
      if (run && this.goalRun !== run) return { success: false, error: 'The native goal run already stopped.' };
      await this.goalDeadline(this.client.start());
      assertNativeGoalsVersion(this.client.getServerVersion?.());
      const threadId = this.codexThreadId;
      if (!threadId) throw new Error('No native goal session was created.');
      this.rememberGoalManagement();
      const existing = await this.getGoal();
      let goal = existing;
      if (existing && existing.status !== 'complete') {
        const paused = await this.goalRequest('thread/goal/set', { threadId, status: 'paused', origin: 'user' });
        goal = parseNativeGoal(paused?.goal, threadId);
        if (!goal || goal.status === 'active') throw new Error('Codex did not confirm that the native goal is paused.');
      }
      if (clear && existing) {
        const response = await this.goalRequest('thread/goal/clear', { threadId, origin: 'user' });
        if (typeof response?.cleared !== 'boolean') throw new Error('Codex did not confirm clearing the native goal.');
        goal = null;
      }
      if (run) {
        run.goal = goal;
        for (const pending of this.pendingUserInputs.splice(0)) {
          this.finishApproval(pending, 'expired');
          this.client.respond(pending.id, pending.method === 'item/tool/requestUserInput' ? { answers: {} }
            : pending.method === 'item/permissions/requestApproval' ? { permissions: {}, scope: 'turn' } : { decision: 'cancel' });
        }
        for (const turnId of [...run.inFlight]) await this.goalRequest('turn/interrupt', { threadId, turnId });
        if (run.inFlight.size) await this.goalDeadline(new Promise<void>(resolve => { run.onIdle = resolve; }));
        if (this.goalRun !== run) throw new Error('The native goal stopped before its control operation finished.');
      }
      // A late dispatched continuation must not outlive a successful stop ACK.
      // Reopening this process is safe because native state is now paused/cleared.
      await this.stopGoalTransport();
      this.goalNeedsResume = false;
      if (run) {
        if (this.goalRun !== run) throw new Error('The native goal stopped before its control operation finished.');
        run.inFlight.clear();
        run.ready = true;
        run.controlling = false;
        this.maybeCompleteGoal(run);
        const result = await this.goalDeadline(run.done);
        if (!result.success) throw new Error(result.error ?? 'Native goal did not stop successfully.');
      }
      return { success: true, output: clear ? 'Native goal cleared; execution stopped.'
        : goal?.status === 'complete' ? 'Native goal was already complete; execution stopped.'
          : goal ? 'Native goal paused; execution stopped.' : 'No native goal is set; execution stopped.' };
    } catch (error) {
      if (run && this.goalRun === run) {
        run.controlling = false;
        await this.failGoal(run, `Native goal control failed: ${nativeGoalError(error)}. ${GOAL_RECOVERY_GUIDANCE}`);
      }
      return { success: false, error: nativeGoalError(error) };
    }
  }

  getExecutionMetadata() {
    const data = configuredExecutionMetadata(this.model, this.effort);
    if (this.threadReady && this.client.isRunning() && this.reportedModel) {
      data.model = this.reportedModel;
      data.modelSource = 'reported';
    }
    if (this.threadReady && this.client.isRunning() && this.reportedEffort && (!this.effort || this.effort === this.reportedEffort)) {
      data.reasoningEffort = this.reportedEffort;
      data.effortSource = 'reported';
    }
    return data;
  }

  private captureReportedSettings(response: any): void {
    if (typeof response?.model === 'string' && response.model.trim()) this.reportedModel = response.model;
    if (typeof response?.reasoningEffort === 'string' && response.reasoningEffort.trim()) this.reportedEffort = response.reasoningEffort;
  }

  isBusy(): boolean {
    return this.activeTurn !== null || this.compactWaiter !== null || this.transportStop !== null
      || this.goalControl !== null || this.threadLoads > 0;
  }

  hasUncertainShutdown(): boolean {
    return this.transportStop !== null;
  }

  async setWorkingDirectory(targetPath: string): Promise<void> {
    const resolved = this.directoryGuard.resolveWorkingDirectory(
      targetPath,
      this.currentWorkingDirectory
    );
    if (resolved === this.currentWorkingDirectory) return;
    if (this.isBusy()) throw new Error('Cannot change working directory while Codex is busy');
    await this.client.stop();
    this.resetContext();
    this.currentWorkingDirectory = resolved;
    this.client.setWorkingDirectory(resolved);
  }

  getSandboxStatus(): string {
    return this.sandbox.describe(this.currentWorkingDirectory);
  }

  async configureSandbox(command: string): Promise<ExecuteResult> {
    if (this.isBusy()) return { success: false, error: 'Wait for the running task before changing sandbox settings.' };
    try {
      const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(command.trim());
      const action = match?.[1] ?? '';
      const value = match?.[2] ?? '';
      const config = this.sandbox.getConfig() ?? { mode: 'workspace-write' as const };
      let next: CodexSandboxConfig | undefined = { ...config };
      if (action === 'default' && !value) next = undefined;
      else if (['on', 'off', 'read-only'].includes(action) && !value) {
        next.mode = action === 'on' ? 'workspace-write' : action === 'off' ? 'danger-full-access' : 'read-only';
      } else if (action === 'network' && ['on', 'off'].includes(value)) next.networkAccess = value === 'on';
      else if (['allow', 'remove'].includes(action) && value) {
        const directory = this.sandbox.normalize(value, this.currentWorkingDirectory);
        next.writableRoots = action === 'allow'
          ? [...new Set([...(config.writableRoots ?? []), directory])]
          : (config.writableRoots ?? []).filter(root => root !== directory);
        if (action === 'remove' && next.writableRoots.length === (config.writableRoots ?? []).length) {
          return { success: false, error: 'That directory is not an extra grant. Default development directories are controlled by developmentDirectories in the configuration.' };
        }
      } else return { success: false, error: 'Usage: /sandbox on|off|read-only|default; /sandbox network on|off; /sandbox allow|remove <directory>' };
      await this.client.stop();
      this.threadReady = false;
      this.sandbox.configure(next);
      return { success: true, output: this.getSandboxStatus() };
    } catch (error) {
      return { success: false, error: this.errorMessage(error) };
    }
  }

  resetContext(): void {
    if (this.goalRun) throw new Error('Stop the native goal before clearing its conversation.');
    this.taskNotifications.clear();
    const previousId = this.codexThreadId;
    if (this.activeTurn || this.compactWaiter) {
      this.completeActive({ success: false, error: 'Conversation cleared by user' });
      this.completeCompact({ success: false, error: 'Conversation cleared by user' });
      void this.client.stop();
    }
    this.codexThreadId = null;
    this.goalManaged = false;
    this.goalNeedsResume = false;
    this.threadReady = false;
    this.pendingUserInputs = [];
    this.clearThreadId();
    if (previousId && this.client.isRunning()) {
      void this.client.request('thread/unsubscribe', { threadId: previousId }).catch(() => undefined);
    }
  }

  async abort(): Promise<boolean> {
    if (this.goalRun) return (await this.pauseGoal()).success;
    if (this.transportStop) {
      await this.transportStop;
      if (this.transportStop) {
        // Only an explicit abort may retry a failed ordinary transport stop.
        // Replace the settled fence synchronously so admission cannot slip through.
        this.transportStop = null;
        await this.stopOrdinaryTransport();
      }
      if (this.transportStop) return false;
      this.completeActive({ success: false, error: 'Aborted by user' });
      this.completeCompact({ success: false, error: 'Aborted by user' });
      return true;
    }
    const active = this.activeTurn;
    if (!active || !this.codexThreadId) return false;

    for (const pending of this.pendingUserInputs.splice(0)) {
      this.finishApproval(pending, 'expired');
      this.client.respond(
        pending.id,
        pending.method === 'item/tool/requestUserInput'
          ? { answers: {} }
          : pending.method === 'item/permissions/requestApproval'
          ? { permissions: {}, scope: 'turn' }
          : { decision: 'cancel' }
      );
    }

    if (!active.turnId) {
      await this.failAndRestart('Aborted by user');
      return !this.hasUncertainShutdown();
    }

    try {
      await this.client.request('turn/interrupt', {
        threadId: this.codexThreadId,
        turnId: active.turnId,
      });
    } catch {
      await this.failAndRestart('Aborted by user');
    }
    return !this.hasUncertainShutdown();
  }

  async destroy(): Promise<void> {
    if (this.destroyed && !this.goalRun) return;
    this.destroyed = true;
    this.taskNotifications.clear();
    this.unsubscribeClient?.();
    this.unsubscribeClient = null;
    if (this.goalRun) {
      this.goalRun.stopping = true;
      this.clearInactivityTimer();
      await this.stopGoalTransport();
    }
    if (this.activeTurn) this.completeActive({ success: false, error: 'Executor destroyed' });
    this.completeCompact({ success: false, error: 'Executor destroyed' });
    await this.client.stop();
  }

  async waitForExit(): Promise<void> {
    if (this.client.waitForExit) await this.client.waitForExit();
    else if (this.client.isRunning()) throw new Error('Codex app-server process exit could not be confirmed');
  }

  async waitForManagedProcessGroupExit(): Promise<void> {
    if (!this.delegationWorker || !this.client.waitForManagedProcessGroupExit) {
      throw new Error('Worker transport cannot confirm managed process-group exit');
    }
    await this.client.waitForManagedProcessGroupExit();
  }

  consumeSessionResumeFailure(): boolean {
    const failed = this.sessionResumeFailure;
    this.sessionResumeFailure = false;
    return failed;
  }

  isProcessRunning(): boolean {
    return this.client.isRunning();
  }

  getSessionId(): string | null {
    return this.codexThreadId;
  }

  isWaitingInput(): boolean {
    return this.pendingUserInputs.length > 0;
  }

  sendInput(input: string): boolean {
    const pending = this.pendingUserInputs.shift();
    if (!pending) return false;
    return this.resolveUserInput(pending, input);
  }

  respondToApproval(requestId: string, action: ApprovalAction): boolean {
    const index = this.pendingUserInputs.findIndex(input => input.approval?.requestId === requestId);
    if (index < 0 || !['approve', 'deny', 'remember'].includes(action)) return false;
    if (action === 'remember' && !this.pendingUserInputs[index].approval?.canRemember) return false;
    const [pending] = this.pendingUserInputs.splice(index, 1);
    return this.resolveUserInput(pending, action === 'approve' ? 'yes' : action === 'deny' ? 'no' : 'remember');
  }

  private resolveUserInput(pending: PendingUserInput, input: string): boolean {
    try {
      return this.applyUserInput(pending, input);
    } catch {
      // A transport write failure must not orphan a pending card or answer a
      // different request on retry. Process termination expires it normally.
      if (this.activeTurn) this.pendingUserInputs.unshift(pending);
      else this.finishApproval(pending, 'expired');
      return false;
    }
  }

  private applyUserInput(pending: PendingUserInput, input: string): boolean {
    const normalized = input.trim().toLowerCase();

    if (pending.method === 'item/tool/requestUserInput') {
      const questions = Array.isArray(pending.params?.questions) ? pending.params.questions : [];
      const answers: Record<string, { answers: string[] }> = {};
      for (const question of questions) {
        if (typeof question?.id === 'string') answers[question.id] = { answers: [input.trim()] };
      }
      this.client.respond(pending.id, { answers });
      return true;
    }

    if (pending.method === 'item/permissions/requestApproval') {
      if (!['yes', 'y', 'accept', 'always', 'remember', 'no', 'n', 'decline', 'cancel'].includes(normalized)) {
        this.pendingUserInputs.unshift(pending);
        return false;
      }
      const approved = ['yes', 'y', 'accept', 'always', 'remember'].includes(normalized);
      const permissions = approved ? pending.params.permissions ?? {} : {};
      if (normalized === 'remember') {
        try {
          this.rememberApproval(pending);
        } catch (error) {
          this.pendingUserInputs.unshift(pending);
          this.activeTurn?.options.onStream?.(`\n${this.errorMessage(error)}\n`);
          return false;
        }
      }
      this.client.respond(pending.id, { permissions, scope: ['always', 'remember'].includes(normalized) ? 'session' : 'turn' });
      this.finishApproval(pending, normalized === 'remember' ? 'remembered' : approved ? 'approved' : 'denied');
      return true;
    }

    if (normalized === 'remember' && pending.method === 'item/fileChange/requestApproval' && pending.params.grantRoot) {
      try {
        this.rememberApproval(pending);
        this.client.respond(pending.id, { decision: 'acceptForSession' });
        this.finishApproval(pending, 'remembered');
        return true;
      } catch (error) {
        this.pendingUserInputs.unshift(pending);
        this.activeTurn?.options.onStream?.(`\n${this.errorMessage(error)}\n`);
        return false;
      }
    }

    const decision = normalized === 'always' ? 'acceptForSession'
      : normalized === 'yes' || normalized === 'y' || normalized === 'accept' ? 'accept'
      : normalized === 'cancel' ? 'cancel'
      : normalized === 'no' || normalized === 'n' || normalized === 'decline' ? 'decline'
      : null;
    if (!decision) {
      this.pendingUserInputs.unshift(pending);
      return false;
    }
    this.client.respond(pending.id, { decision });
    this.finishApproval(pending, decision === 'accept' || decision === 'acceptForSession' ? 'approved' : 'denied');
    return true;
  }

  async listModels(): Promise<ExecutorModelInfo[]> {
    await this.refreshModelCatalogAfterCommandUpgrade();
    return this.readModelCatalog();
  }

  private async readModelCatalog(): Promise<ExecutorModelInfo[]> {
    const models: ExecutorModelInfo[] = [];
    let cursor: string | null = null;
    const currentModelId = this.reportedModel ?? this.model;
    do {
      const owner = this.goalRun;
      const params: { cursor: string | null; limit: number; includeHidden: boolean } = {
        cursor,
        limit: 100,
        includeHidden: false,
      };
      const response: any = await (owner ? this.goalRequest('model/list', params) : this.client.request('model/list', params));
      if (owner) this.assertGoalOwner(owner);
      for (const model of Array.isArray(response?.data) ? response.data : []) {
        if (typeof model?.id !== 'string') continue;
        models.push({
          id: model.id,
          displayName: model.displayName ?? model.id,
          description: model.description,
          isDefault: model.isDefault === true,
          isCurrent: currentModelId ? model.id === currentModelId : undefined,
          supportedReasoningEfforts: Array.isArray(model.supportedReasoningEfforts)
            ? model.supportedReasoningEfforts.map((entry: any) => entry?.reasoningEffort).filter(Boolean)
            : undefined,
          defaultReasoningEffort: typeof model.defaultReasoningEffort === 'string'
            ? model.defaultReasoningEffort
            : undefined,
          inputModalities: Array.isArray(model.inputModalities) ? model.inputModalities : undefined,
          ...(Array.isArray(model.serviceTiers) && model.serviceTiers.length <= 32
            && model.serviceTiers.every((tier: any) => tier && this.validSpeedValue(tier.id) && this.validSpeedValue(tier.name)
              && (tier.description === undefined || (typeof tier.description === 'string' && tier.description.length <= 4096)))
            ? { serviceTiers: model.serviceTiers.map((tier: any) => ({ id: tier.id, name: tier.name, description: tier.description })),
              ...(model.defaultServiceTier === null || this.validSpeedValue(model.defaultServiceTier) ? { defaultServiceTier: model.defaultServiceTier } : {}) } : {}),
        });
      }
      cursor = typeof response?.nextCursor === 'string' ? response.nextCursor : null;
    } while (cursor);
    return models;
  }

  /**
   * Codex app-server keeps its bundled model catalog for the lifetime of the
   * process. If the CLI was upgraded since this persistent process started,
   * recreate the idle transport so `/model` and model validation use the new
   * catalog. The saved Codex thread id remains intact and is resumed later.
   */
  private async refreshModelCatalogAfterCommandUpgrade(): Promise<void> {
    if (!this.client.isRunning() || this.isBusy()) return;
    const runningVersion = this.client.getServerVersion?.();
    if (!runningVersion) return;
    let commandVersion: string | null;
    try {
      commandVersion = await this.client.getCommandVersion?.() ?? null;
    } catch {
      return;
    }
    if (!commandVersion || commandVersion === runningVersion) return;
    if (this.isBusy() || !this.client.isRunning() || this.client.getServerVersion?.() !== runningVersion) return;

    console.log(`[CodexAppServerExecutor] Codex upgraded from ${runningVersion} to ${commandVersion}; refreshing the idle model catalog`);
    await this.client.stop();
    this.threadReady = false;
  }

  async getAccountUsage(): Promise<string | null> {
    try {
      const response = await this.client.request('account/rateLimits/read', {
        excludeResetCreditDetails: true,
      }, ACCOUNT_USAGE_TIMEOUT_MS);
      return formatCodexAccountUsage(response);
    } catch (error) {
      console.warn('[CodexAppServerExecutor] Account usage is unavailable', this.errorMessage(error));
      return null;
    }
  }

  async setModel(model: string): Promise<ExecuteResult> {
    try {
      const models = await this.listModels();
      const selected = models.find(entry => entry.id === model);
      if (!selected) {
        return { success: false, error: `Unknown Codex model: ${model}. Use /model to list available models.` };
      }
      if (typeof this.speed === 'string' && (!selected.serviceTiers?.length
        || (this.speed !== 'default' && !selected.serviceTiers.some(tier => tier.id === this.speed)))) {
        return { success: false, error: 'The saved speed is incompatible with this model. Follow native config in the Speed section before changing models.' };
      }
      if (this.effort && !selected.supportedReasoningEfforts?.includes(this.effort)) {
        return { success: false, error: 'The saved reasoning effort is incompatible with this model. Reset /effort auto before changing models.' };
      }
      this.model = model;
      this.reportedModel = undefined;
      this.reportedEffort = undefined;
      return { success: true, output: `Model set to ${model}. Takes effect on the next command.` };
    } catch (error) {
      return { success: false, error: this.errorMessage(error) };
    }
  }

  clearModel(): void {
    if (typeof this.speed === 'string') throw new Error('Follow native config in the Speed section before clearing the model override.');
    this.model = undefined;
    this.reportedModel = undefined;
    this.reportedEffort = undefined;
  }

  private validSpeedValue(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);
  }

  async listSpeeds(models?: ExecutorModelInfo[]): Promise<ExecutorSpeedInfo | undefined> {
    const catalog = models ?? await this.listModels();
    const recovery: ExecutorSpeedInfo | undefined = this.speed !== undefined ? { choices: [], current: this.speed ?? undefined } : undefined;
    // Do not add config RPCs to legacy catalogs or to models with no tier choices.
    if (!catalog.some(model => model.serviceTiers?.length)) return recovery;
    let id = this.reportedModel ?? this.model;
    if (!id) {
      try { id = (await this.readNativeSpeedConfig()).model; }
      catch (error) {
        // A failed native query must not turn a catalog default into an offer of
        // paid speed. A saved override can still be cleared without discovery.
        if (recovery) return recovery;
        throw error;
      }
    }
    const selected = id ? catalog.find(model => model.id === id) : catalog.find(model => model.isDefault);
    if (!selected?.serviceTiers?.length) return recovery;
    const choices = [{ value: 'default', displayName: 'Standard', description: 'Use standard processing.' },
      ...selected.serviceTiers.filter(tier => tier.id !== 'default').map(tier => ({ value: tier.id, displayName: tier.name, description: tier.description }))];
    return { choices, current: this.speed ?? undefined, default: selected.defaultServiceTier };
  }

  private async assertReportedSpeed(speed: string): Promise<void> {
    if (!this.reportedModel) return;
    const owner = this.goalRun;
    const catalog = await (owner ? this.goalDeadline(this.readModelCatalog()) : this.readModelCatalog());
    if (owner) this.assertGoalOwner(owner);
    const selected = catalog.find(model => model.id === this.reportedModel);
    if (!selected?.serviceTiers?.length || (speed !== 'default' && !selected.serviceTiers.some(tier => tier.id === speed))) {
      throw new Error('This speed is unavailable for the model reported by Codex. Follow native config in /model before starting work.');
    }
  }

  private async speedOptions(speed: string | null | undefined = this.speed): Promise<{ serviceTier?: string | null }> {
    if (speed === undefined) return {};
    if (speed !== null) return { serviceTier: speed };
    // Avoid the public upgrade check while preparing a turn: replacing the
    // transport here would discard the native thread just loaded by ensureThread.
    const catalog = await this.readModelCatalog();
    if (!catalog.some(model => model.serviceTiers !== undefined)) {
      if (this.codexThreadId && !(this.threadReady && this.legacyFollowReady)) {
        throw new Error('This Codex version cannot safely clear the speed of a saved conversation. Upgrade Codex or use /clear before resuming.');
      }
      // Old protocols must never receive unsupported serviceTier keys. A fresh
      // thread can safely use native startup configuration without an override.
      return {};
    }
    const config = await this.readNativeSpeedConfig();
    const id = this.reportedModel ?? this.model ?? config.model;
    const selected = id ? catalog.find(model => model.id === id) : catalog.find(model => model.isDefault);
    if (config.tier === 'fast' || config.tier === 'priority') {
      const fast = selected?.serviceTiers?.find(tier => tier.id === 'priority')
        ?? selected?.serviceTiers?.find(tier => tier.id === 'fast');
      return { serviceTier: config.fastMode && fast ? fast.id : null };
    }
    if (config.tier !== null && config.tier !== 'default' && config.tier !== 'flex'
      && !selected?.serviceTiers?.some(tier => tier.id === config.tier)) {
      throw new Error('Codex configured speed is unavailable for the selected model. Check native configuration before resuming.');
    }
    return { serviceTier: config.tier };
  }

  private async readNativeSpeedConfig(): Promise<{ model?: string; tier: string | null; fastMode: boolean }> {
    const owner = this.goalRun;
    const params = { includeLayers: false, cwd: this.currentWorkingDirectory };
    const response = await (owner ? this.goalRequest('config/read', params) : this.client.request('config/read', params));
    if (owner) this.assertGoalOwner(owner);
    if (!response?.config || typeof response.config !== 'object') throw new Error('Codex did not provide its native speed configuration.');
    const native = response.config.service_tier;
    if (native !== undefined && native !== null && !this.validSpeedValue(native)) throw new Error('Codex returned an invalid native speed setting.');
    const model = response.config.model;
    if (model !== undefined && model !== null && !this.validSpeedValue(model)) throw new Error('Codex returned an invalid configured model.');
    const features = response.config.features;
    if (features !== undefined && (features === null || typeof features !== 'object' || Array.isArray(features))) throw new Error('Codex returned invalid native speed features.');
    const fastMode = features?.fast_mode;
    if (fastMode !== undefined && typeof fastMode !== 'boolean') throw new Error('Codex returned an invalid native Fast mode setting.');
    return { model: model ?? undefined, tier: native ?? null, fastMode: fastMode !== false };
  }

  async setSpeed(speed: string | undefined): Promise<ExecuteResult> {
    try {
      const cwd = this.currentWorkingDirectory, threadId = this.codexThreadId;
      const assertCurrent = () => {
        if (this.isBusy() || this.destroyed || cwd !== this.currentWorkingDirectory || threadId !== this.codexThreadId) throw new Error('The Codex thread changed during speed selection.');
      };
      if (this.isBusy() || this.destroyed) throw new Error('The Codex thread must be idle to change speed.');
      if (speed === undefined) {
        // Reset is recovery, not another selection. Never load a saved thread
        // through its obsolete tier, nor resume suspended native goals here.
        this.threadReady = false;
        this.legacyFollowReady = false;
        this.threadLoads++;
        try {
          await this.client.stop();
          await this.client.waitForExit?.();
        } finally { this.threadLoads--; }
        assertCurrent();
        this.speed = null;
        return { success: true, output: 'Speed follows native configuration on the next safe resume. Older Codex versions may require an upgrade or /clear.' };
      }
      const choices = await this.listSpeeds();
      assertCurrent();
      if (!choices || !choices.choices.some(choice => choice.value === speed)) {
        throw new Error('This speed is unavailable for the current Codex model. Refresh /model.');
      }
      if (this.isBusy() || this.destroyed) throw new Error('The Codex thread changed during speed selection.');
      if (this.codexThreadId && !(this.goalManaged && this.goalNeedsResume)) {
        await this.ensureThread();
        assertCurrent();
        // Restored conversations can report a different model than the preview.
        await this.assertReportedSpeed(speed);
        assertCurrent();
        // Explicit selections may update a live thread. Follow never loads it.
        const { serviceTier } = await this.speedOptions(speed);
        assertCurrent();
        await this.client.request('thread/settings/update', { threadId: this.codexThreadId, serviceTier });
        assertCurrent();
      }
      this.speed = speed;
      return { success: true, output: 'Speed preference applied.' };
    } catch (error) {
      return { success: false, error: this.errorMessage(error) };
    }
  }

  async listEfforts(): Promise<ExecutorEffortInfo> {
    const models = await this.listModels();
    const currentModelId = this.reportedModel ?? this.model;
    const activeModel = currentModelId
      ? models.find((entry) => entry.id === currentModelId)
      : models.find((entry) => entry.isDefault);
    if (!activeModel) {
      return {
        choices: [],
        supportsReset: false,
        unavailableReason: 'Codex did not identify a model for reasoning effort validation.',
      };
    }
    const supported = activeModel.supportedReasoningEfforts ?? [];
    if (supported.length === 0) {
      return {
        choices: [],
        supportsReset: false,
        unavailableReason: `Model ${activeModel.id} does not support reasoning effort.`,
      };
    }
    return {
      choices: supported.map((effort) => ({ value: effort, displayName: effort })),
      current: this.reportedEffort ?? this.effort,
      default: activeModel.defaultReasoningEffort,
      supportsReset: true,
    };
  }

  async setEffort(effort: string): Promise<ExecuteResult> {
    if (this.isBusy()) {
      return { success: false, error: 'Cannot change reasoning effort while the Codex thread is busy' };
    }

    try {
      const normalized = effort.trim().toLowerCase();
      const models = await this.listModels();
      const currentModelId = this.reportedModel ?? this.model;
      const activeModel = currentModelId
        ? models.find((entry) => entry.id === currentModelId)
        : models.find((entry) => entry.isDefault);
      if (!activeModel) {
        return { success: false, error: 'Codex returned no models for reasoning effort validation.' };
      }

      if (normalized === 'auto') {
        const defaultEffort = activeModel.defaultReasoningEffort;
        if (!defaultEffort) {
          return { success: false, error: `Codex did not report a default reasoning effort for ${activeModel.id}.` };
        }
        if (this.codexThreadId) {
          await this.ensureThread();
          await this.client.request('thread/settings/update', {
            threadId: this.codexThreadId,
            effort: defaultEffort,
          });
        }
        this.effort = undefined;
        this.reportedEffort = undefined;
        return { success: true, output: `Reasoning effort restored to ${defaultEffort}, the default for ${activeModel.id}.` };
      }

      const supported = activeModel.supportedReasoningEfforts ?? [];
      if (!supported.includes(normalized)) {
        return {
          success: false,
          error: `Unsupported reasoning effort for ${activeModel.id}: ${effort}. Supported values: ${supported.join(', ') || 'unavailable'}.`,
        };
      }
      if (this.codexThreadId) {
        await this.ensureThread();
        await this.client.request('thread/settings/update', {
          threadId: this.codexThreadId,
          effort: normalized,
        });
      }
      this.effort = normalized;
      this.reportedEffort = undefined;
      return { success: true, output: `Reasoning effort set to ${normalized}.` };
    } catch (error) {
      return { success: false, error: this.errorMessage(error) };
    }
  }

  async compactWhenFull(_onStream?: (chunk: string) => void): Promise<ExecuteResult> {
    if (!this.codexThreadId) return { success: true, output: 'No active conversation to compact.' };
    if (this.isBusy()) {
      return { success: false, error: 'Cannot compact while the Codex thread is busy' };
    }

    try {
      await this.ensureThread();
      return await new Promise<ExecuteResult>((resolve) => {
        const timer = setTimeout(() => {
          this.completeCompact({ success: false, error: 'Codex compaction timed out' });
        }, this.compactTimeoutMs);
        this.compactWaiter = { resolve, timer };
        void this.client.request('thread/compact/start', { threadId: this.codexThreadId }).catch((error) => {
          this.completeCompact({ success: false, error: this.errorMessage(error) });
        });
      });
    } catch (error) {
      return { success: false, error: this.errorMessage(error) };
    }
  }

  async deleteThreadData(_threadId: string): Promise<void> {
    await this.destroy();
    this.clearThreadId();
    this.codexThreadId = null;
    this.threadReady = false;
    this.sandbox.deleteData();
  }

  private async ensureThread(): Promise<void> {
    this.threadLoads++;
    try { await this.loadThread(); }
    finally { this.threadLoads--; }
  }

  private async loadThread(): Promise<void> {
    assertWorkingDirectoryExists(this.currentWorkingDirectory);
    if (this.goalManaged && this.codexThreadId && !this.goalRun) {
      const goal = await this.getGoal();
      if (this.goalNeedsResume || goal?.status === 'active') throw new Error(GOAL_RECOVERY_GUIDANCE);
    }
    if (this.threadReady && this.client.isRunning()) return;
    this.threadReady = false;
    this.legacyFollowReady = false;
    const goalOwner = this.goalRun;
    this.reportedModel = undefined;
    this.reportedEffort = undefined;
    await this.client.start();
    if (goalOwner) this.assertGoalOwner(goalOwner);
    if (typeof this.speed === 'string') {
      const available = await (goalOwner ? this.goalDeadline(this.listSpeeds()) : this.listSpeeds());
      if (goalOwner) this.assertGoalOwner(goalOwner);
      if (!available?.choices.some(choice => choice.value === this.speed)) {
        throw new Error('The saved speed is unavailable for this Codex model. Follow native config in /model before starting work.');
      }
    }

    const speedOptions = await this.speedOptions();
    if (goalOwner) this.assertGoalOwner(goalOwner);
    const common: any = {
      ...(this.model ? { model: this.model } : {}),
      ...speedOptions,
      cwd: this.currentWorkingDirectory,
      ...(this.autoApprove ? {
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
      } : {}),
      ...this.sandbox.threadOptions(this.currentWorkingDirectory, this.delegationWorker || !!this.delegation),
    };
    // A saved active goal can dispatch during resume, before settings/update.
    if (goalOwner && this.effort) common.config = { ...common.config, model_reasoning_effort: this.effort };
    if (this.delegationConfigured) {
      common.config = { ...common.config,
        'mcp_servers.remote_cli_delegation': this.delegation
          ? { ...delegationMcpConfig(this.delegation), enabled: true, required: true, tool_timeout_sec: 35,
            // /delegation on authorizes these local control tools. Each worker
            // still enforces its inherited sandbox and requests native approvals.
            enabled_tools: DELEGATION_TOOLS.map(tool => tool.name), default_tools_approval_mode: 'approve' }
          : { command: process.execPath, enabled: false },
      };
    }

    if (this.codexThreadId) {
      try {
        const response = await this.client.request('thread/resume', {
          threadId: this.codexThreadId,
          excludeTurns: true,
          ...common,
        });
        if (response?.thread?.id !== this.codexThreadId) {
          throw new Error('Codex app-server resumed an unexpected thread');
        }
        if (goalOwner) this.assertGoalOwner(goalOwner);
        this.captureReportedSettings(response);
      } catch (error) {
        if (this.delegationWorker && this.isMissingStoredThreadError(error)) {
          // `thread/resume` runs before `turn/start`, so this is the one native
          // failure delegation may replace with a fresh isolated worker lane.
          this.sessionResumeFailure = true;
        }
        throw new Error(`Stored Codex thread could not be resumed: ${this.errorMessage(error)}. Use /clear to start fresh.`);
      }
    } else {
      const response = await this.client.request('thread/start', {
        ...common,
        serviceName: 'remote_cli',
      });
      const id = response?.thread?.id;
      if (goalOwner) this.assertGoalOwner(goalOwner);
      if (typeof id !== 'string' || !id) throw new Error('Codex app-server returned no thread ID');
      this.captureReportedSettings(response);
      this.setThreadId(id);
      this.legacyFollowReady = this.speed === null && !Object.prototype.hasOwnProperty.call(common, 'serviceTier');
    }
    if (typeof this.speed === 'string') await this.assertReportedSpeed(this.speed);
    if (goalOwner) this.assertGoalOwner(goalOwner);
    this.threadReady = true;
  }

  private handleMessage(message: AppServerMessage): void {
    if (this.destroyed || this.transportStop) return;
    const method = message.method;
    if (!method) return;
    const params = message.params ?? {};

    if (method === 'client/disconnected') {
      this.taskNotifications.clear();
      this.threadReady = false;
      if (this.goalRun) {
        if (!this.goalTransportStops) {
          void this.failGoal(this.goalRun, `${params.error ?? 'Codex app-server disconnected'}. ${GOAL_RECOVERY_GUIDANCE}`);
        }
      } else if (this.activeTurn) {
        this.completeActive({ success: false, error: params.error ?? 'Codex app-server disconnected' });
      }
      this.completeCompact({ success: false, error: params.error ?? 'Codex app-server disconnected' });
      return;
    }

    if (message.id !== undefined) {
      this.handleServerRequest(message.id, method, params);
      return;
    }

    if (params.threadId && params.threadId !== this.codexThreadId) return;
    const goalRun = this.goalRun;
    if (goalRun?.stopping) return;
    // Goal changes may arrive after their turn completed, or without any turn ID.
    if (goalRun && (method === 'thread/goal/updated' || method === 'thread/goal/cleared')) {
      if (params.threadId !== this.codexThreadId) return;
      try {
        const goal = method === 'thread/goal/cleared' ? null : parseNativeGoal(params.goal, this.codexThreadId!);
        if (method === 'thread/goal/updated' && !goal) throw new Error('Codex returned an empty native goal update.');
        if (goal && (goalRun.objective && goal.objective !== goalRun.objective
          || goalRun.goal && goal.updatedAt < goalRun.goal.updatedAt)) return;
        goalRun.goal = goal;
        goalRun.revision++;
        this.maybeCompleteGoal(goalRun);
      } catch (error) { void this.failGoal(goalRun, nativeGoalError(error)); }
      return;
    }
    if (method === 'serverRequest/resolved') {
      this.pendingUserInputs = this.pendingUserInputs.filter(pending => {
        if (pending.id !== params.requestId) return true;
        this.finishApproval(pending, 'expired');
        return false;
      });
      return;
    }
    const eventTurnId = params.turnId ?? params.turn?.id;
    const matchesActiveTurn = !eventTurnId || eventTurnId === this.activeTurn?.turnId;
    const notified = this.taskNotifications.handle(method, params,
      matchesActiveTurn ? this.activeTurn?.options.onTaskNotification : undefined);
    if (notified) return;
    // Late background output must not become part of a subsequent turn.
    if (eventTurnId && !matchesActiveTurn && method !== 'turn/started'
      && !(method === 'turn/completed' && goalRun?.inFlight.has(eventTurnId))
      && params.item?.type !== 'contextCompaction') return;
    if (this.activeTurn) this.armInactivityTimer();

    switch (method) {
      case 'turn/started':
        if (goalRun) {
          const id = params.turn?.id;
          if (params.threadId !== this.codexThreadId || typeof id !== 'string' || !id || goalRun.retired.has(id)) break;
          goalRun.inFlight.add(id);
          if (this.activeTurn?.turnId !== id) {
            if (goalRun.retired.size && goalRun.active.output.length) {
              goalRun.active.output.push('\n\n');
              goalRun.active.options.onStream?.('\n\n');
              goalRun.active.options.onDisplayText?.('\n\n');
            }
            goalRun.active.emittedTools.clear();
            goalRun.active.itemPhases.clear();
            goalRun.active.error = undefined;
            goalRun.active.errorCode = undefined;
          }
          this.goalNotice(goalRun, 'Native goal running');
        }
        if (this.activeTurn && typeof params.turn?.id === 'string') this.activeTurn.turnId = params.turn.id;
        break;
      case 'thread/status/changed':
        if (goalRun && params.status?.type === 'idle' && goalRun.goal?.status === 'active') {
          this.goalNotice(goalRun, 'Native goal active; waiting for native continuation or user control');
        }
        break;
      case 'item/agentMessage/delta':
        if (this.activeTurn && typeof params.delta === 'string') {
          this.activeTurn.output.push(params.delta);
          if (goalRun && this.activeTurn.output.reduce((size, part) => size + part.length, 0) > 65_536) {
            this.activeTurn.output = ['[Earlier native goal output omitted from this diagnostic buffer]\n',
              this.activeTurn.output.join('').slice(-65_536)];
          }
          this.activeTurn.options.onStream?.(params.delta);
          this.activeTurn.options.onDisplayText?.(params.delta);
          const phase = params.itemId ? this.activeTurn.itemPhases.get(params.itemId) : undefined;
          if (phase === 'commentary') {
            this.activityTracker.emitPublicText(params.delta);
          }
        }
        break;
      case 'item/reasoning/summaryTextDelta':
        if (this.activeTurn && typeof params.delta === 'string') {
          if (!this.activeTurn.options.onActivity) this.activeTurn.options.onStream?.(params.delta);
          const key = params.itemId ? `${params.itemId}:${params.summaryIndex ?? 0}` : undefined;
          this.activityTracker.emitReasoningSummary(params.delta, key);
        }
        break;
      case 'turn/plan/updated':
        if (this.activeTurn && Array.isArray(params.plan)) {
          const plan = params.plan.map((entry: any) => `${entry.status === 'completed' ? '✅' : entry.status === 'inProgress' ? '🔄' : '⬜'} ${entry.step}`).join('\n');
          if (plan) this.activeTurn.options.onPlanMode?.(plan);
          const activity = extractTodoPlan({ todos: params.plan });
          if (activity) this.activityTracker.emitPlan(activity);
        }
        break;
      case 'item/started':
        this.handleItemStarted(params.item);
        break;
      case 'item/completed':
        this.handleItemCompleted(params.item);
        break;
      case 'error': {
        const error = params.error ?? params;
        if (this.activeTurn) {
          this.activeTurn.error = error?.message ?? 'Codex turn failed';
          this.activeTurn.errorCode = this.extractErrorCode(error?.codexErrorInfo);
        }
        break;
      }
      case 'turn/completed':
        this.handleTurnCompleted(params.turn);
        break;
      case 'thread/compacted':
        if (this.compactWaiter) this.completeCompact({ success: true });
        break;
      default:
        break;
    }
  }

  private approvalRoots(pending: Pick<PendingUserInput, 'method' | 'params'>): string[] {
    if (this.sandbox.getConfig()?.mode !== 'workspace-write') {
      throw new Error('Remember requires workspace-write mode and explicit writable directories.');
    }
    let writes: unknown[];
    if (pending.method === 'item/fileChange/requestApproval') writes = [pending.params.grantRoot];
    else {
      const permissions = pending.params.permissions ?? {};
      const entries = permissions.fileSystem?.entries ?? [];
      const legacyWrites = permissions.fileSystem?.write ?? [];
      if (permissions.network?.enabled || !Array.isArray(entries) || !Array.isArray(legacyWrites)
        || entries.some((entry: any) => entry.access !== 'write' || entry.path?.type !== 'path')) {
        throw new Error('Only explicit writable-directory grants can be remembered.');
      }
      writes = [...legacyWrites, ...entries.map((entry: any) => entry.path.path)];
    }
    if (!writes.length) throw new Error('No explicit writable directories were requested.');
    return writes.map(root => {
      if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('Permission grants must use absolute directory paths.');
      return this.sandbox.normalize(root);
    });
  }

  private rememberApproval(pending: PendingUserInput): void {
    const roots = this.approvalRoots(pending);
    if (pending.approval?.writableRoots && JSON.stringify(roots) !== JSON.stringify(pending.approval.writableRoots)) {
      throw new Error('The requested directory changed after the approval was displayed. Request a fresh authorization.');
    }
    const config = this.sandbox.getConfig()!;
    this.sandbox.configure({ ...config, writableRoots: [...new Set([...(config.writableRoots ?? []), ...roots])] });
  }

  private queueApproval(id: number | string, method: string, params: any, fallback: string): void {
    let writableRoots: string[] | undefined;
    if (method !== 'item/commandExecution/requestApproval') {
      try { writableRoots = this.approvalRoots({ method, params }); } catch { /* Not a persistent directory grant. */ }
    }
    const kind = method.includes('commandExecution') ? 'command' : method.includes('fileChange') ? 'file' : 'permissions';
    const description = [params.reason, kind === 'command' ? params.command : undefined,
      kind === 'file' && params.grantRoot ? `Requested directory: ${params.grantRoot}` : undefined,
      kind === 'permissions' ? JSON.stringify(params.permissions ?? {}, null, 2) : undefined,
      params.cwd ? `Command directory: ${params.cwd}` : undefined,
    ].filter(Boolean).join('\n') || 'Codex requested permission for file changes.';
    const approval: ApprovalRequestInfo = { requestId: randomUUID(), kind, description,
      canRemember: !!writableRoots?.length, ...(writableRoots ? { writableRoots } : {}) };
    this.pendingUserInputs.push({ id, method, params, approval, resolved: this.activeTurn?.options.onApprovalResolved });
    let cardHandled = false;
    try { cardHandled = this.activeTurn?.options.onApprovalRequest?.(approval) === true; } catch { /* Keep text approvals available. */ }
    if (!cardHandled) this.activeTurn?.options.onStream?.(fallback);
  }

  private finishApproval(pending: PendingUserInput, status: ApprovalStatus): void {
    try {
      if (pending.approval) pending.resolved?.(pending.approval.requestId, status);
    } catch { /* Rendering failures must not make an accepted request executable again. */ }
  }

  private handleServerRequest(id: number | string, method: string, params: any): void {
    if (this.goalRun && (this.goalRun.stopping || this.goalRun.controlling || !this.goalRun.inFlight.size
      || params.turnId && !this.goalRun.inFlight.has(params.turnId))) {
      this.client.respondError(id, 'Request does not belong to a running native goal turn');
      return;
    }
    if (params.threadId && params.threadId !== this.codexThreadId) {
      this.client.respondError(id, 'Request does not belong to this remote-cli thread');
      return;
    }
    if (!this.activeTurn || (params.turnId && this.activeTurn.turnId && params.turnId !== this.activeTurn.turnId)) {
      this.client.respondError(id, 'Request does not belong to the active turn');
      return;
    }
    this.armInactivityTimer();

    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      if (this.autoApprove && !this.sandbox.isRestricted()) {
        this.client.respond(id, { decision: 'accept' });
        return;
      }
      const subject = method.includes('commandExecution')
        ? params.command ?? params.reason ?? 'command execution'
        : params.reason ?? params.grantRoot ?? 'file changes';
      const boundary = this.sandbox.isRestricted() ? ' This may run outside the sandbox. Use /sandbox allow <directory> between tasks to save a directory grant.' : '';
      const remember = method === 'item/fileChange/requestApproval' && params.grantRoot && this.sandbox.getConfig()?.mode === 'workspace-write'
        ? `, remember (save write access to ${params.grantRoot})` : '';
      this.queueApproval(id, method, params, `\nApproval required for ${subject}.${boundary} Reply yes, always${remember}, no, or cancel.\n`);
      return;
    }

    if (method === 'item/permissions/requestApproval') {
      this.queueApproval(id, method, params, `\nAdditional permissions requested: ${JSON.stringify(params.permissions ?? {})}\n${params.reason ?? ''}\nReply yes (this turn), always (this Codex session), remember (save writable directories for this thread), or no.\n`);
      return;
    }

    if (method === 'item/tool/requestUserInput') {
      this.pendingUserInputs.push({ id, method, params });
      const questions = Array.isArray(params.questions) ? params.questions : [];
      const text = questions.map((question: any) => question?.question).filter(Boolean).join('\n');
      this.activeTurn?.options.onStream?.(`\n${text || 'Codex requires input.'}\nReply with your answer.\n`);
      return;
    }

    this.client.respondError(id, `Unsupported Codex app-server request: ${method}`);
  }

  private handleItemStarted(item: any): void {
    const active = this.activeTurn;
    if (!active || !item || typeof item.id !== 'string') return;
    const id = item.id;
    if (typeof item.phase === 'string') {
      active.itemPhases.set(id, item.phase);
    }

    switch (item.type) {
      case 'commandExecution':
        active.sideEffectsStarted = true;
        this.emitCommandUse(active, item);
        break;
      case 'fileChange':
        active.sideEffectsStarted = true;
        this.emitToolUse(active, id, 'Edit', { file_path: item.changes?.[0]?.path ?? '' }, item.title || item.description);
        break;
      case 'webSearch': {
        const { input, description } = codexWebSearchUse(item);
        this.emitToolUse(active, id, 'WebSearch', input, undefined, description);
        break;
      }
      case 'mcpToolCall':
      case 'dynamicToolCall':
        active.sideEffectsStarted = true;
        this.emitToolUse(active, id, item.tool ?? 'MCP', item.arguments ?? {}, item.title || item.description);
        break;
      default:
        break;
    }
  }

  private handleItemCompleted(item: any): void {
    if (this.compactWaiter && item?.type === 'contextCompaction') {
      this.completeCompact({ success: true });
      return;
    }

    const active = this.activeTurn;
    if (!active || !item || typeof item.id !== 'string') return;
    const id = item.id;
    active.itemPhases.delete(id);

    switch (item.type) {
      case 'commandExecution':
        this.emitCommandUse(active, item);
        active.options.onToolResult?.({
          tool_use_id: id,
          content: item.aggregatedOutput ?? '',
          is_error: item.status !== 'completed' || (typeof item.exitCode === 'number' && item.exitCode !== 0),
        });
        break;
      case 'fileChange': {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        const diffs = changes
          .map((change: any) => {
            if (typeof change?.diff !== 'string' || !change.diff) return '';
            if (/^(?:diff --git |--- .*\r?\n\+\+\+ )/m.test(change.diff)) return change.diff;
            // Native fileChange hunks can omit file headers. Preserve the file
            // boundary before concatenating a multi-file tool result.
            const filePath = String(change.path ?? 'file').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
            const kind = typeof change.kind === 'string' ? change.kind : change.kind?.type;
            const oldPath = kind === 'add' ? '/dev/null' : `a/${filePath}`;
            const newPath = kind === 'delete' ? '/dev/null' : `b/${filePath}`;
            return `--- ${oldPath}\n+++ ${newPath}\n${change.diff}`;
          })
          .filter(Boolean)
          .join('\n');
        this.emitToolUse(active, id, 'Edit', { file_path: changes[0]?.path ?? '', ...(diffs ? { diff: diffs } : {}) });
        active.options.onToolResult?.({
          tool_use_id: id,
          content: changes.map((change: any) => `${typeof change.kind === 'string' ? change.kind : change.kind?.type ?? 'update'}: ${change.path ?? ''}`).join('\n'),
          ...(diffs ? { diff: diffs } : {}),
          is_error: item.status !== 'completed',
        });
        break;
      }
      case 'webSearch': {
        const { input, description } = codexWebSearchUse(item);
        this.emitToolUse(active, id, 'WebSearch', input, undefined, description);
        active.options.onToolResult?.(codexWebSearchResult(item));
        break;
      }
      case 'mcpToolCall':
      case 'dynamicToolCall':
        this.emitToolUse(active, id, item.tool ?? 'MCP', item.arguments ?? {});
        this.handleGeneratedImage(active, item);
        active.options.onToolResult?.({
          tool_use_id: id,
          content: codexToolResultText(item.result ?? item.contentItems ?? item.error ?? ''),
          is_error: item.status !== 'completed' || item.success === false || Boolean(item.error),
        });
        break;
      case 'plan':
        if (typeof item.text === 'string' && item.text) {
          active.options.onPlanMode?.(item.text);
          this.activityTracker.emitPlan(item.text);
        }
        break;
      case 'imageGeneration':
        this.handleGeneratedImage(active, item);
        break;
      default:
        break;
    }
    const tool = active.emittedTools.get(id);
    if (tool) tool.completed = true;
  }

  private handleTurnCompleted(turn: any): void {
    const active = this.activeTurn;
    if (!active || !turn) return;
    const run = this.goalRun;
    if (run) {
      if (!run.inFlight.has(turn.id) || run.retired.has(turn.id)) return;
      run.inFlight.delete(turn.id);
      if (!run.inFlight.size) run.onIdle?.();
      run.retired.add(turn.id);
      if (run.retired.size > 256) run.retired.delete(run.retired.values().next().value!);
      if (active.turnId === turn.id) active.turnId = null;
      this.pendingUserInputs = this.pendingUserInputs.filter(pending => {
        if (pending.params.turnId && pending.params.turnId !== turn.id) return true;
        this.finishApproval(pending, 'expired');
        return false;
      });
      if (turn.status !== 'completed' && !run.controlling) {
        void this.failGoal(run, turn.status === 'interrupted' ? 'Native goal interrupted. Resume explicitly to continue.'
          : turn.error?.message ?? active.error ?? 'Native goal turn failed.');
      } else {
        this.maybeCompleteGoal(run);
        if (run.ready && this.goalRun === run) void this.checkGoalAfterTurn(run);
      }
      return;
    }
    if (active.turnId && turn.id && active.turnId !== turn.id) return;

    if (turn.status === 'completed') {
      this.completeActive({
        success: true,
        output: active.output.join(''),
        sessionAbbr: this.codexThreadId?.slice(0, 8),
      });
      return;
    }
    if (turn.status === 'interrupted') {
      this.completeActive({ success: false, error: 'Aborted by user' });
      return;
    }
    const rawError = turn.error?.message ?? active.error ?? 'Codex turn failed';
    const code = this.extractErrorCode(turn.error?.codexErrorInfo) ?? active.errorCode;
    const error = code === 'ContextWindowExceeded' && !active.sideEffectsStarted
      ? `Prompt too long: ${rawError}`
      : rawError;
    this.completeActive({ success: false, error });
  }

  private emitCommandUse(active: ActiveTurn, item: any): void {
    const explicit = [item.description, item.title].find(value => typeof value === 'string' && value.trim());
    const publicLabel = typeof explicit === 'string' ? sanitizeActivityText(explicit) : undefined;
    const actionsLabel = describeCodexCommandActions(item.commandActions);
    const hasNativeAction = actionsLabel !== undefined && item.commandActions.some((action: any) =>
      ['read', 'search', 'listFiles'].includes(action?.type));
    const description = publicLabel || actionsLabel || describeCodexCommandActions(undefined, item.command ?? '')!;
    this.emitToolUse(active, item.id, 'Bash', { command: item.command ?? '' }, publicLabel, description,
      !publicLabel && !hasNativeAction);
  }

  private emitToolUse(active: ActiveTurn, id: string, name: string, input: Record<string, any>, title?: string,
    description?: string, fallback = false): void {
    const previous = active.emittedTools.get(id);
    // A late completion may refresh its result, but another use after a result
    // would be interpreted by the Router as a new invocation of the same ID.
    if (previous?.completed) return;
    title = title || previous?.title;
    description = !description || (fallback && previous?.description && !previous.fallback)
      ? previous?.description : description;
    if (previous && previous.title === title && previous.description === description) return;
    active.emittedTools.set(id, { title, description, fallback });
    active.options.onToolUse?.({ id, name, input, ...(title ? { title } : {}), ...(description ? { description } : {}) });
    this.activityTracker.emitTool(name, input, description ?? title);
  }

  private handleGeneratedImage(active: ActiveTurn, item: any): void {
    const parsed = active.images.extract(item, active.turnId);
    for (const artifact of parsed.artifacts) {
      if ('image' in artifact) active.options.onImage?.(artifact.image);
      else active.options.onImageFile?.(artifact.path);
    }
    if (parsed.notice) {
      active.output.push(parsed.notice);
      active.options.onStream?.(parsed.notice);
    }
  }

  private completeActive(result: ExecuteResult): void {
    const active = this.activeTurn;
    if (!active) return;
    this.activeTurn = null;
    if (this.goalRun?.active === active) {
      this.goalRun.onIdle?.();
      this.goalRun = null;
    }
    this.activityTracker.reset();
    this.activityTracker.setCallback(undefined);
    for (const pending of this.pendingUserInputs.splice(0)) this.finishApproval(pending, 'expired');
    this.clearInactivityTimer();
    if (active.timeoutTimer) clearTimeout(active.timeoutTimer);
    void this.cleanupTemporaryFiles(active.temporaryFiles);
    active.resolve(result);
  }

  private completeCompact(result: ExecuteResult): void {
    const waiter = this.compactWaiter;
    if (!waiter) return;
    this.compactWaiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve(result);
  }

  private async failAndRestart(error: string): Promise<void> {
    if (this.goalRun) return this.failGoal(this.goalRun, error);
    if (this.transportStop) {
      await this.transportStop;
      return;
    }
    this.taskNotifications.clear();
    this.threadReady = false;
    const stopping = this.stopOrdinaryTransport();
    // The fence is installed before stop() emits client/disconnected. Keep the
    // foreground operation active until shutdown settles so pool admission and
    // queued work cannot overtake uncertain native execution.
    await stopping;
    this.completeActive({ success: false, error });
    this.completeCompact({ success: false, error });
  }

  private stopOrdinaryTransport(): Promise<void> {
    if (this.transportStop) return this.transportStop;
    let settle!: () => void;
    const done = new Promise<void>(resolve => { settle = resolve; });
    this.transportStop = done;
    void (async () => {
      let confirmed = false;
      try {
        await this.client.stop();
        if (this.client.waitForExit) await this.client.waitForExit();
        else if (this.client.isRunning()) throw new Error('Codex app-server process exit could not be confirmed');
        confirmed = true;
      } catch (stopError) {
        console.error('[CodexAppServerExecutor] Transport stop could not be confirmed; keeping the executor busy:',
          this.errorMessage(stopError));
      } finally {
        if (confirmed && this.transportStop === done) this.transportStop = null;
        settle();
      }
    })();
    return done;
  }

  private armInactivityTimer(): void {
    this.clearInactivityTimer();
    if (!this.activeTurn) return;
    const inactivityTimeoutMs = this.activeTurn.inactivityTimeoutMs ?? this.inactivityTimeoutMs;
    if (!Number.isFinite(inactivityTimeoutMs) || inactivityTimeoutMs <= 0) return;
    this.inactivityTimer = setTimeout(() => {
      void this.failAndRestart(`No output from Codex for ${inactivityTimeoutMs}ms (inactivity timeout)`);
    }, inactivityTimeoutMs);
  }

  private clearInactivityTimer(): void {
    if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
    this.inactivityTimer = null;
  }

  private async buildInput(prompt: string, attachments: Attachment[] | undefined, temporaryFiles: string[]): Promise<any[]> {
    const input: any[] = [];
    if (prompt) input.push({ type: 'text', text: prompt, text_elements: [] });
    for (const attachment of attachments ?? []) {
      if (attachment.type !== 'image') continue;
      const extension = this.extensionForMimeType(attachment.mimeType);
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'remote-cli-codex-image-'));
      const filePath = path.join(directory, `attachment.${extension}`);
      await fs.promises.writeFile(filePath, Buffer.from(attachment.data, 'base64'), { mode: 0o600 });
      temporaryFiles.push(filePath);
      input.push({ type: 'localImage', path: filePath });
    }
    return input;
  }

  private async cleanupTemporaryFiles(files: string[]): Promise<void> {
    const directories = new Set(files.map((file) => path.dirname(file)));
    await Promise.all(Array.from(directories).map((directory) =>
      fs.promises.rm(directory, { recursive: true, force: true }).catch(() => undefined)
    ));
  }

  private extensionForMimeType(mimeType: string): string {
    if (mimeType === 'image/jpeg') return 'jpg';
    if (mimeType === 'image/webp') return 'webp';
    if (mimeType === 'image/gif') return 'gif';
    return 'png';
  }

  private loadThreadId(): void {
    try {
      const session = JSON.parse(fs.readFileSync(this.sessionFilePath, 'utf8'));
      if (typeof session.id === 'string' && session.id) this.codexThreadId = session.id;
      this.goalManaged = !!this.codexThreadId && session.goalManaged === true;
      this.goalNeedsResume = this.goalManaged;
    } catch {
      this.codexThreadId = null;
      this.goalManaged = false;
      this.goalNeedsResume = false;
    }
  }

  private setThreadId(id: string): void {
    this.codexThreadId = id;
    const temporaryPath = `${this.sessionFilePath}.${process.pid}.tmp`;
    const data = JSON.stringify({ id, savedAt: new Date().toISOString(), ...(this.goalManaged ? { goalManaged: true } : {}) });
    try {
      fs.writeFileSync(temporaryPath, data, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporaryPath, this.sessionFilePath);
    } catch (error) {
      try { fs.unlinkSync(temporaryPath); } catch { /* Ignore cleanup failure. */ }
      console.error('[CodexAppServerExecutor] Failed to save thread ID:', error);
    }
  }

  private clearThreadId(): void {
    try {
      fs.unlinkSync(this.sessionFilePath);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') console.error('[CodexAppServerExecutor] Failed to delete session file:', error);
    }
  }

  /** Persist opt-in before a native mutation; a failed write must prevent activation. */
  private rememberGoalManagement(): void {
    this.goalManaged = true;
    if (!this.codexThreadId) return;
    const temporaryPath = `${this.sessionFilePath}.${process.pid}.goal.tmp`;
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify({ id: this.codexThreadId, goalManaged: true,
        savedAt: new Date().toISOString() }), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporaryPath, this.sessionFilePath);
    } catch {
      try { fs.unlinkSync(temporaryPath); } catch { /* Keep the previous binding intact. */ }
      throw new Error('Could not persist native goal ownership. No goal activation was requested.');
    }
  }

  private extractErrorCode(info: any): string | undefined {
    if (typeof info === 'string') return info;
    if (!info || typeof info !== 'object') return undefined;
    if (typeof info.type === 'string') return info.type;
    return Object.keys(info)[0];
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private isMissingStoredThreadError(error: unknown): boolean {
    const message = this.errorMessage(error).toLowerCase();
    return /(?:no|unknown|missing)\s+(?:rollout|thread|session)/.test(message)
      || /(?:rollout|thread|session).*(?:not found|does not exist|missing)/.test(message);
  }
}
