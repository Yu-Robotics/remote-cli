import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { DirectoryGuard } from '../security/DirectoryGuard';
import type { Attachment } from '../types';
import { configuredExecutionMetadata } from './ExecutionMetadata';
import type {
  ExecuteOptions,
  ExecuteResult,
  ExecutorContextUsage,
  ExecutorModelInfo,
  ExecutorEffortInfo,
  IExecutor,
  NativeSessionResult,
  NativeSessionTarget,
} from './IExecutor';
import { PiClient } from './pi/PiClient';
import { sameConnection, type DelegationConnection } from '../delegation/contract';
import { assertWorkingDirectoryExists } from '../utils/WorkingDirectory';
import { ActivityTracker } from './Activity';
import {
  formatPiModelRef,
  isPiThinkingLevel,
  parsePiModelRef,
  PI_THINKING_LEVELS,
  type PiLaunchOptions,
  type PiModel,
  type PiRpcResponse,
  type PiTransport,
} from './pi/PiTypes';

export interface PiExecutorOptions {
  model?: string;
  effort?: string;
  provider?: string;
  autoApprove?: boolean;
  initialWorkingDirectory?: string;
  piCommand?: string;
  threadId?: string;
  delegationWorker?: boolean;
  sessionBaseDir?: string;
  clientFactory?: (launch: PiLaunchOptions) => PiTransport;
  /** Native inactivity limit in milliseconds; `0` disables the watchdog. */
  inactivityTimeoutMs?: number;
}

interface ActiveTurn {
  options: ExecuteOptions;
  resolve: (result: ExecuteResult) => void;
  output: string[];
  error?: string;
  lastRetryError?: string;
  /** remote-cli-owned reason that Pi's own aborted-turn events must not replace. */
  programError?: string;
  sawAgentStart: boolean;
  /** One-shot hard execution deadline from `ExecuteOptions.timeout`. */
  timeoutTimer?: ReturnType<typeof setTimeout>;
  /** Re-armed inactivity watchdog; every Pi event resets it. */
  inactivityTimer?: ReturnType<typeof setTimeout>;
  /** In-flight failure cleanup, awaited by an /abort that arrives during it. */
  failing?: Promise<void>;
  settle?: () => void;
  /** Fallback ids from tool_execution_start events lacking toolCallId, consumed FIFO by matching end events. */
  pendingToolFallbackIds: string[];
  nextToolFallbackId: number;
}

interface PendingUiRequest {
  id: string;
  method: string;
  title?: string;
  options?: PiUiOption[];
}

interface PiUiOption {
  label: string;
  value: string;
  description?: string;
}

interface SessionPointer {
  id?: string;
  sessionFile?: string;
  cwd?: string;
  /** The user explicitly connected this thread to an existing native session. */
  adopted?: boolean;
}

const MISSING_ADOPTED_ERROR = 'The connected Pi session is no longer available on this computer. Send /session detach to start a fresh conversation, or /resume to connect another session.';

function sameFilePath(left: string, right: string): boolean {
  const canonical = (value: string) => { try { return fs.realpathSync.native(value); } catch { return path.resolve(value); } };
  return canonical(left) === canonical(right);
}

/**
 * Default inactivity window: any Pi event re-arms it, so total duration alone
 * never fails a turn. Matches the Agy and Codex backends.
 */
const DEFAULT_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;
const COMPACT_TIMEOUT_MS = 10 * 60 * 1000;
/** Grace period to distinguish immediate slash/extension commands from a real agent turn. */
const IMMEDIATE_SETTLE_MS = 750;
const INSTALL_COMMAND = 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent';

function mapPiTool(toolName: string, args: Record<string, unknown> | undefined): { name: string; input: Record<string, unknown> } {
  const input = args && typeof args === 'object' ? args : {};
  switch (toolName) {
    case 'bash':
      return { name: 'Bash', input: { command: input.command ?? input.cmd ?? '' } };
    case 'read':
      return { name: 'Read', input: { file_path: input.path ?? input.file_path ?? '' } };
    case 'edit':
      return { name: 'Edit', input: { file_path: input.path ?? input.file_path ?? '' } };
    case 'write':
      return { name: 'Write', input: { file_path: input.path ?? input.file_path ?? '' } };
    case 'grep':
      return { name: 'Grep', input };
    case 'find':
      return { name: 'Glob', input };
    default:
      return { name: toolName, input };
  }
}

function extractMessageText(message: any): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map((block: any) => {
      if (typeof block === 'string') return block;
      if (block?.type === 'text') return String(block.text ?? '');
      return '';
    }).join('');
  }
  return '';
}

function extractAgentError(event: Record<string, any>): string | undefined {
  if (typeof event.finalError === 'string' && event.finalError.trim()) {
    return event.finalError.trim();
  }
  const messages = Array.isArray(event.messages) ? event.messages : [];
  for (const message of messages) {
    if (message?.role !== 'assistant') continue;
    if (message.stopReason !== 'error' && typeof message.errorMessage !== 'string') continue;
    const text = typeof message.errorMessage === 'string' && message.errorMessage.trim()
      ? message.errorMessage.trim()
      : extractMessageText(message).trim();
    return text || 'Pi agent ended with an error';
  }
  return undefined;
}

function toolResultText(result: any): string {
  if (!result) return '';
  if (typeof result === 'string') return result;
  const content = result.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((block) => {
      if (typeof block === 'string') return block;
      if (block?.type === 'text') return String(block.text ?? '');
      return JSON.stringify(block);
    }).join('');
  }
  return JSON.stringify(result);
}

function normalizeUiOption(option: unknown): PiUiOption {
  if (typeof option === 'string') return { label: option, value: option };
  if (option && typeof option === 'object') {
    const record = option as Record<string, unknown>;
    const label = [record.label, record.name, record.title, record.value]
      .find((value) => typeof value === 'string' && value.trim()) as string | undefined;
    const value = typeof record.value === 'string' && record.value.trim() ? record.value : label;
    const description = typeof record.description === 'string' && record.description.trim()
      ? record.description.trim()
      : undefined;
    if (label && value) return { label: label.trim(), value: value.trim(), description };
  }
  const text = String(option);
  return { label: text, value: text };
}

function retryNotice(event: Record<string, any>): string {
  const attempt = Number.isFinite(event.attempt) ? Number(event.attempt) : undefined;
  const maxAttempts = Number.isFinite(event.maxAttempts) ? Number(event.maxAttempts) : undefined;
  const delayMs = Number.isFinite(event.delayMs) ? Number(event.delayMs) : undefined;
  const progress = attempt !== undefined
    ? `${attempt}${maxAttempts !== undefined ? `/${maxAttempts}` : ''}`
    : '';
  const delay = delayMs !== undefined
    ? ` in ${delayMs >= 1000 ? `${Number((delayMs / 1000).toFixed(1))}s` : `${delayMs}ms`}`
    : '';
  const rawError = typeof event.errorMessage === 'string' ? event.errorMessage.replace(/\s+/g, ' ').trim() : '';
  const error = rawError.length > 240 ? `${rawError.slice(0, 237)}...` : rawError;
  return `\n⏳ Pi retry${progress ? ` ${progress}` : ''}${delay}${error ? `: ${error}` : ''}\n`;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Persistent Pi executor backed by `pi --mode rpc`.
 * One instance is owned by one remote-cli thread.
 */
export class PiExecutor implements IExecutor {
  private readonly directoryGuard: DirectoryGuard;
  private currentWorkingDirectory: string;
  private model?: string;
  private effort?: string;
  private reportedModel?: string;
  private reportedEffort?: string;
  private readonly provider?: string;
  private readonly autoApprove: boolean;
  private readonly threadId?: string;
  private readonly inactivityTimeoutMs: number;
  private readonly sessionFilePath: string;
  private readonly sessionStoreDir: string;
  private readonly piCommand?: string;
  private readonly createClient: (launch: PiLaunchOptions) => PiTransport;

  private client: PiTransport;
  private readonly retiredClients = new Set<PiTransport>();
  private unsubscribe: (() => void) | null = null;
  private sessionId: string | null = null;
  private sessionFile: string | null = null;
  /** Fresh foreground identity, distinct from the stable remote thread. */
  private freshSessionId = randomUUID();
  /** Adopted native history is user-owned: never deleted, never renamed. */
  private adopted = false;
  private nativeSessionMutation = false;
  private nativeSessionMutationCancelled = false;
  private nativeSessionMutationDone: Promise<void> | null = null;
  private nativeSessionCleanup = 0;
  private preparingTurn: { cancelled: boolean } | null = null;
  private activeTurn: ActiveTurn | null = null;
  private readonly activityTracker = new ActivityTracker();
  private pendingUi: PendingUiRequest | null = null;
  /** Pi's own dialog timeout (it sends no event when it resolves the dialog). */
  private pendingUiExpiry: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private delegation?: DelegationConnection;
  private readonly delegationWorker: boolean;

  async configureDelegation(connection?: DelegationConnection): Promise<void> {
    if (sameConnection(this.delegation, connection)) return;
    if (this.isBusy()) throw new Error('Cannot change delegation while Pi is busy');
    await this.recycleClient();
    this.delegation = connection;
  }

  constructor(directoryGuard: DirectoryGuard, options: PiExecutorOptions = {}) {
    this.directoryGuard = directoryGuard;
    this.model = options.model;
    this.effort = options.effort && options.effort !== 'auto' ? options.effort : undefined;
    this.provider = options.provider;
    this.autoApprove = options.autoApprove ?? true;
    this.threadId = options.threadId;
    this.inactivityTimeoutMs = options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;
    this.delegationWorker = options.delegationWorker ?? false;
    this.piCommand = options.piCommand;

    if (options.initialWorkingDirectory) {
      try {
        this.currentWorkingDirectory = directoryGuard.resolveWorkingDirectory(options.initialWorkingDirectory);
      } catch (error) {
        console.warn(`[PiExecutor] Failed to use initial working directory: ${options.initialWorkingDirectory}`, error);
        this.currentWorkingDirectory = process.cwd();
      }
    } else {
      this.currentWorkingDirectory = process.cwd();
    }

    const baseDir = options.sessionBaseDir
      ?? path.join(process.env.HOME || os.homedir(), '.remote-cli', 'pi-sessions');
    fs.mkdirSync(baseDir, { recursive: true });
    this.sessionStoreDir = path.join(baseDir, 'store');
    fs.mkdirSync(this.sessionStoreDir, { recursive: true });
    this.sessionFilePath = this.threadId
      ? path.join(baseDir, `${this.threadId}.json`)
      : path.join(this.currentWorkingDirectory, '.pi-session');
    this.loadPointer();

    this.createClient = options.clientFactory ?? ((launch) => new PiClient(launch));
    this.client = this.createClient(this.buildLaunch());
    this.unsubscribe = this.client.onEvent((event) => this.handleEvent(event));
  }

  async execute(prompt: string, options: ExecuteOptions = {}): Promise<ExecuteResult> {
    if (this.destroyed) throw new Error('Executor has been destroyed');
    if (this.isBusy()) {
      return { success: false, error: 'Pi thread is already running a command' };
    }

    const trimmed = prompt.trim();
    if (trimmed === '/skills' || trimmed === '/skill') {
      return this.listSkills();
    }
    const preparation = { cancelled: false };
    this.preparingTurn = preparation;
    try {
      // Each native Pi process caches a branch. Reload adopted history before
      // every remote turn; the user must keep other writers idle.
      if (this.adopted) await this.recycleClient();
      if (preparation.cancelled || this.destroyed) return { success: false, error: 'Pi command cancelled before startup' };
      await this.ensureClient();
      if (preparation.cancelled || this.destroyed) {
        await this.recycleClient();
        return { success: false, error: 'Pi command cancelled before dispatch' };
      }
      if (trimmed.startsWith('/')) {
        const validationError = await this.validateSlashCommand(trimmed);
        if (validationError) return { success: false, error: validationError };
      }
      if (preparation.cancelled || this.destroyed) return { success: false, error: 'Pi command cancelled before dispatch' };
    } catch (error) {
      return { success: false, error: this.friendlyError(error) };
    } finally {
      if (this.preparingTurn === preparation) this.preparingTurn = null;
    }

    return new Promise<ExecuteResult>((resolve) => {
      const active: ActiveTurn = {
        options,
        resolve,
        output: [],
        sawAgentStart: false,
        pendingToolFallbackIds: [],
        nextToolFallbackId: 0,
      };
      this.activeTurn = active;
      this.armTurnDeadlines(active);
      this.activityTracker.setCallback(options.onActivity);
      this.activityTracker.reset();

      const settled = new Promise<void>((settle) => {
        active.settle = settle;
      });

      const images = this.toImages(options.attachments);
      void this.client.request({
        type: 'prompt',
        message: prompt,
        ...(images.length > 0 ? { images } : {}),
      }).then(async (response) => {
        if (this.activeTurn !== active) return;
        if (!response.success) {
          this.completeActive({ success: false, error: response.error || 'Pi rejected the prompt' });
          return;
        }
        const outcome = await Promise.race([
          settled.then(() => 'settled' as const),
          sleep(IMMEDIATE_SETTLE_MS).then(() => 'grace' as const),
        ]);
        if (this.activeTurn !== active) return;
        if (outcome === 'grace' && !active.sawAgentStart && !active.error) {
          const streaming = await this.isSessionStreaming();
          if (this.activeTurn !== active) return;
          if (!streaming && !active.sawAgentStart) {
            const text = active.output.join('') || await this.lastAssistantText();
            this.completeActive({ success: true, output: text, sessionAbbr: this.sessionAbbr() });
            return;
          }
        }
        await settled;
        if (this.activeTurn !== active) return;
        let output = active.output.join('');
        if (!output && !active.error) {
          output = await this.lastAssistantText();
        }
        if (!output && !active.error) {
          active.error = active.lastRetryError || 'Pi completed the turn without a text response';
        }
        this.completeActive({
          success: !active.error,
          output,
          error: active.error,
          sessionAbbr: this.sessionAbbr(),
        });
      }).catch((error) => {
        if (this.activeTurn === active) {
          this.completeActive({ success: false, error: this.friendlyError(error) });
        }
      });
    });
  }

  getCurrentWorkingDirectory(): string {
    return this.currentWorkingDirectory;
  }

  isBusy(): boolean {
    return this.activeTurn !== null || this.preparingTurn !== null || this.nativeSessionMutation || this.nativeSessionCleanup > 0;
  }

  async setWorkingDirectory(targetPath: string): Promise<void> {
    const resolved = this.directoryGuard.resolveWorkingDirectory(
      targetPath,
      this.currentWorkingDirectory
    );
    if (resolved === this.currentWorkingDirectory) return;
    if (this.isBusy()) throw new Error('Cannot change working directory while Pi is busy');

    this.currentWorkingDirectory = resolved;
    // A Pi session owns the cwd recorded in its session header. Reopening the
    // previous session file would silently keep tools in the old directory.
    this.clearPointer();
    this.client.updateLaunch?.(this.buildLaunch());
    await this.recycleClient();
  }

  resetContext(): void {
    if (this.destroyed) return;
    if (this.nativeSessionMutation) throw new Error('Cannot clear Pi context while a session connection is changing');
    if (this.preparingTurn) this.preparingTurn.cancelled = true;
    this.cancelPendingUi(true);
    if (this.activeTurn) {
      this.completeActive({
        success: false,
        error: 'Conversation cleared by user',
        sessionAbbr: this.sessionAbbr(),
      });
    }
    this.forgetSession();
    this.replaceClient();
  }

  async abort(): Promise<boolean> {
    const mutation = this.nativeSessionMutationDone;
    if (mutation) {
      this.nativeSessionMutationCancelled = true;
      await this.stopNativeSessionMutation(mutation);
      return true;
    }
    if (this.preparingTurn) {
      this.preparingTurn.cancelled = true;
      await this.recycleClient();
      return true;
    }
    if (!this.client.isRunning()) return false;
    const active = this.activeTurn;
    // A deadline that already claimed this turn owns its abort, so a second
    // abort RPC (or a concurrent /abort) must not be sent for the same turn.
    const alreadyClaimed = active?.programError !== undefined;
    if (active) this.clearTurnTimers(active);
    if (alreadyClaimed) {
      // Wait for the in-flight failure instead of releasing the turn: Pi is still
      // stopping, and its late aborted events would land on the next turn.
      if (active?.failing) await active.failing;
      return true;
    }
    // Pi settles its own aborted turn before answering the abort RPC, so claim
    // remote-cli's reason first.
    if (active) active.programError = 'Aborted';
    let cleanupError: unknown;
    const cleanup = (async () => {
      try {
        await this.client.request({ type: 'clear_queue' });
      } catch {
        // Queue may already be empty.
      }
      // A successor turn may own the session by now (this turn can settle while
      // the queue request is pending); its abort belongs to that turn.
      if (this.activeTurn !== active) return;
      try {
        await this.client.request({ type: 'abort' });
      } catch (error) {
        // Only a turn that still owns the session may recycle its transport; a
        // late failure must not stop the client of a turn starting or started
        // meanwhile, including one still in preparation.
        if (this.activeTurn === active || (!this.activeTurn && !this.preparingTurn)) {
          try { await this.recycleClient(); }
          catch (failure) { cleanupError = failure; }
        }
      }
    })();
    // A concurrent /abort waits for this cleanup instead of starting its own.
    if (active) active.failing = cleanup;
    await cleanup;
    if (active && this.activeTurn === active) {
      const claimed = active.programError ?? 'Aborted';
      active.programError = cleanupError ? `${claimed}; ${this.friendlyError(cleanupError)}` : claimed;
      this.completeActive({ success: false, error: active.programError, sessionAbbr: this.sessionAbbr() });
    }
    if ((!this.activeTurn && !this.preparingTurn) || this.activeTurn === active) this.cancelPendingUi(true);
    if (cleanupError) throw cleanupError;
    return true;
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.nativeSessionMutationCancelled = true;
    if (this.preparingTurn) this.preparingTurn.cancelled = true;
    this.cancelPendingUi(true);
    if (this.activeTurn) {
      this.completeActive({ success: false, error: 'Executor destroyed' });
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    const mutation = this.nativeSessionMutationDone;
    if (mutation) await this.stopNativeSessionMutation(mutation);
    else await this.recycleClient();
  }

  /** Abort native context changes without RPC requests that could restart a stopped client. */
  private async stopNativeSessionMutation(mutation: Promise<void>): Promise<void> {
    this.nativeSessionCleanup += 1;
    try {
      // Interrupt startup first, then await rollback before the final exit check.
      try { await this.recycleClient(); } catch { /* confirmed cleanup is required below */ }
      await mutation;
      await this.recycleClient();
    } finally { this.nativeSessionCleanup -= 1; }
  }

  /**
   * `recycleClient` waits for the Pi transport's stop operation. Check every
   * retained transport too, so delegation does not reuse a lane after an
   * uncertain process shutdown.
   */
  async waitForExit(): Promise<void> {
    const clients = [this.client, ...this.retiredClients];
    await Promise.all(clients.map(async (client) => {
      if (client.waitForExit) await client.waitForExit();
      else if (client.isRunning()) throw new Error('Pi RPC process exit could not be confirmed');
    }));
  }

  isWaitingInput(): boolean {
    return this.pendingUi !== null;
  }

  sendInput(input: string): boolean {
    if (!this.pendingUi) return false;
    const pending = this.pendingUi;
    const trimmed = input.trim();
    if (!trimmed) return false;
    this.pendingUi = null;
    // The reply restarts the wait for Pi, so it re-arms the watchdog rather
    // than inheriting the little time left from before the prompt.
    if (this.activeTurn) this.armInactivityTimer(this.activeTurn);

    if (pending.method === 'confirm') {
      if (/^(n|no|cancel|false)$/i.test(trimmed)) {
        this.client.send({ type: 'extension_ui_response', id: pending.id, cancelled: true });
      } else {
        this.client.send({ type: 'extension_ui_response', id: pending.id, confirmed: true });
      }
      return true;
    }

    if (/^(skip|cancel)$/i.test(trimmed)) {
      this.client.send({ type: 'extension_ui_response', id: pending.id, cancelled: true });
      return true;
    }

    const options = pending.options ?? [];
    const index = Number.parseInt(trimmed, 10);
    if (!Number.isNaN(index) && index >= 1 && index <= options.length) {
      this.client.send({ type: 'extension_ui_response', id: pending.id, value: options[index - 1].value });
      return true;
    }
    const match = options.find((option) => (
      option.label.toLowerCase() === trimmed.toLowerCase()
      || option.value.toLowerCase() === trimmed.toLowerCase()
    ));
    this.client.send({ type: 'extension_ui_response', id: pending.id, value: match?.value ?? trimmed });
    return true;
  }

  async compact(onStream?: (chunk: string) => void): Promise<ExecuteResult> {
    return this.compactWhenFull(onStream);
  }

  async compactWhenFull(onStream?: (chunk: string) => void): Promise<ExecuteResult> {
    if (this.isBusy()) {
      return { success: false, error: 'Cannot compact while a Pi command is running' };
    }
    try {
      await this.ensureClient();
      onStream?.('Compressing Pi conversation...\n');
      const response = await this.client.request({ type: 'compact' }, COMPACT_TIMEOUT_MS);
      if (!response.success) {
        return { success: false, error: response.error || 'Pi compaction failed' };
      }
      const summary = typeof response.data?.summary === 'string' ? response.data.summary : '';
      if (summary) onStream?.(summary);
      await this.refreshSessionPointer();
      return { success: true, output: summary, sessionAbbr: this.sessionAbbr() };
    } catch (error) {
      return { success: false, error: this.friendlyError(error) };
    }
  }

  async setModel(model: string): Promise<ExecuteResult> {
    const trimmed = model.trim();
    if (!trimmed) return { success: false, error: 'Model name is required' };
    try {
      await this.ensureClient();
      const resolved = await this.resolveModel(trimmed);
      if (!resolved) {
        return { success: false, error: `Unknown Pi model: ${trimmed}` };
      }
      const response = await this.client.request({
        type: 'set_model',
        provider: resolved.provider,
        modelId: resolved.modelId,
      });
      if (!response.success) {
        return { success: false, error: response.error || `Failed to set Pi model: ${trimmed}` };
      }
      this.model = formatPiModelRef({ id: resolved.modelId, provider: resolved.provider });
      this.reportedModel = undefined;
      this.reportedEffort = undefined;
      this.client.updateLaunch?.({ model: this.model, provider: resolved.provider });
      return { success: true, output: `Model set to ${this.model}.` };
    } catch (error) {
      return { success: false, error: this.friendlyError(error) };
    }
  }

  async clearModel(): Promise<void> {
    await this.recycleClient();
    this.model = undefined;
    this.reportedModel = undefined;
    this.reportedEffort = undefined;
    this.client.updateLaunch?.({ model: undefined, provider: this.provider });
  }

  async listModels(): Promise<ExecutorModelInfo[]> {
    await this.ensureClient();
    const response = await this.client.request({ type: 'get_available_models' });
    if (!response.success) {
      throw new Error(response.error || 'Failed to list Pi models');
    }
    const currentModelId = this.reportedModel ?? this.model;
    let currentModelThinkingLevels: string[] | undefined;
    try {
      const levelsResponse = await this.client.request({ type: 'get_available_thinking_levels' });
      if (levelsResponse.success && Array.isArray(levelsResponse.data?.levels)) {
        currentModelThinkingLevels = levelsResponse.data.levels.map(String);
      }
    } catch {
      // Ignore failure to fetch thinking levels
    }

    const models = Array.isArray(response.data?.models) ? response.data.models as PiModel[] : [];
    return models.map((model) => {
      const modelRef = formatPiModelRef(model);
      const isCurrent = Boolean(currentModelId && (modelRef === currentModelId || model.id === currentModelId));
      let supportedReasoningEfforts: string[] | undefined;
      if (isCurrent && currentModelThinkingLevels) {
        supportedReasoningEfforts = currentModelThinkingLevels;
      } else if (!model.reasoning) {
        supportedReasoningEfforts = ['off'];
      } else {
        supportedReasoningEfforts = undefined;
      }
      return {
        id: modelRef,
        displayName: model.name || model.id,
        isDefault: undefined,
        isCurrent: isCurrent || undefined,
        supportedReasoningEfforts,
        inputModalities: model.input,
      };
    });
  }

  async listEfforts(): Promise<ExecutorEffortInfo> {
    await this.ensureClient();
    try {
      const response = await this.client.request({ type: 'get_available_thinking_levels' });
      if (!response.success || !Array.isArray(response.data?.levels) || response.data.levels.length === 0) {
        return {
          choices: [],
          supportsReset: false,
          unavailableReason: response.error || 'Current model does not support reasoning effort',
        };
      }
      const levels: string[] = response.data.levels.map(String);
      return {
        choices: levels.map((level) => ({ value: level, displayName: level })),
        current: this.reportedEffort ?? this.effort,
        default: undefined,
        supportsReset: true,
      };
    } catch (error) {
      return {
        choices: [],
        supportsReset: false,
        unavailableReason: this.friendlyError(error),
      };
    }
  }

  async setEffort(effort: string): Promise<ExecuteResult> {
    const trimmed = effort.trim().toLowerCase();
    if (trimmed === 'auto') {
      try { await this.recycleClient(); } catch (error) { return { success: false, error: this.friendlyError(error) }; }
      this.effort = undefined;
      this.reportedEffort = undefined;
      this.client.updateLaunch?.({ thinking: undefined });
      return { success: true, output: 'Reasoning effort set to auto.' };
    }
    if (!isPiThinkingLevel(trimmed)) {
      return {
        success: false,
        error: `Unsupported Pi thinking level: ${effort}. Use auto, ${PI_THINKING_LEVELS.join(', ')}.`,
      };
    }
    try {
      await this.ensureClient();
      const available = await this.listEfforts();
      if (!available.choices.some(choice => choice.value === trimmed)) return { success: false, error: 'This thinking level is not supported by the selected Pi model.' };
      const response = await this.client.request({ type: 'set_thinking_level', level: trimmed });
      if (!response.success) {
        return { success: false, error: response.error || `Failed to set thinking level: ${trimmed}` };
      }
      this.effort = trimmed;
      this.reportedEffort = undefined;
      this.client.updateLaunch?.({ thinking: trimmed });
      return { success: true, output: `Reasoning effort set to ${trimmed}.` };
    } catch (error) {
      return { success: false, error: this.friendlyError(error) };
    }
  }

  isProcessRunning(): boolean {
    return this.client.isRunning();
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  getExecutionMetadata() {
    const data = configuredExecutionMetadata(this.model, this.effort);
    if (this.client.isRunning() && this.reportedModel) {
      data.model = this.reportedModel;
      data.modelSource = 'reported';
    }
    if (this.client.isRunning() && this.reportedEffort) {
      data.reasoningEffort = this.reportedEffort;
      data.effortSource = 'reported';
    }
    return data;
  }

  async getContextUsage(): Promise<ExecutorContextUsage | null> {
    try {
      await this.ensureClient();
      const response = await this.client.request({ type: 'get_session_stats' });
      if (!response.success || !response.data) return null;
      const tokens = response.data.tokens;
      const context = response.data.contextUsage;
      const usage: ExecutorContextUsage = {
        inputTokens: finiteNumber(tokens?.input),
        outputTokens: finiteNumber(tokens?.output),
        cacheReadTokens: finiteNumber(tokens?.cacheRead),
        cacheWriteTokens: finiteNumber(tokens?.cacheWrite),
        totalTokens: finiteNumber(tokens?.total),
        contextTokens: context?.tokens === null ? null : finiteNumber(context?.tokens),
        contextWindow: finiteNumber(context?.contextWindow),
        contextPercent: context?.percent === null ? null : finiteNumber(context?.percent),
      };
      return Object.values(usage).some((value) => value !== undefined) ? usage : null;
    } catch {
      // Older Pi releases do not expose get_session_stats.
      return null;
    }
  }

  async deleteThreadData(threadId: string): Promise<void> {
    const pointerPath = path.join(path.dirname(this.sessionFilePath), `${threadId}.json`);
    let sessionFile = this.sessionFile;
    let adopted = threadId === this.threadId && this.adopted;
    try {
      const stored = JSON.parse(fs.readFileSync(pointerPath, 'utf8')) as SessionPointer;
      sessionFile = stored.sessionFile ?? sessionFile;
      adopted = adopted || stored.adopted === true;
    } catch {
      // Pointer may already be gone.
    }
    try { fs.unlinkSync(pointerPath); } catch { /* ignore */ }
    if (sessionFile && !adopted && !this.isForegroundSession(threadId)) {
      try { fs.unlinkSync(sessionFile); } catch { /* ignore */ }
    }
    if (threadId === this.threadId) {
      this.sessionId = null;
      this.sessionFile = null;
      this.adopted = false;
    }
  }

  private async listSkills(): Promise<ExecuteResult> {
    try {
      await this.ensureClient();
      const response = await this.client.request({ type: 'get_commands' });
      if (!response.success) {
        return { success: false, error: response.error || 'Failed to list Pi commands' };
      }
      const commands = Array.isArray(response.data?.commands) ? response.data.commands : [];
      const skills = commands.filter((command: any) => command?.source === 'skill');
      if (skills.length === 0) {
        return { success: true, output: '🧩 No Pi skills were discovered.\n\nSkills live under ~/.pi/agent/skills, ~/.agents/skills, .pi/skills, and .agents/skills. Invoke them as /skill:name.' };
      }
      const lines = skills.map((skill: any) => `- /${skill.name}${skill.description ? ` — ${skill.description}` : ''}`);
      return { success: true, output: `🧩 Available Pi skills:\n${lines.join('\n')}\n\nInvoke with /skill:name` };
    } catch (error) {
      return { success: false, error: this.friendlyError(error) };
    }
  }

  private async validateSlashCommand(prompt: string): Promise<string | undefined> {
    try {
      await this.ensureClient();
      const response = await this.client.request({ type: 'get_commands' });
      if (!response.success) return response.error || 'Failed to query Pi commands';
      const commandName = prompt.slice(1).split(/\s+/, 1)[0];
      const commands = Array.isArray(response.data?.commands) ? response.data.commands : [];
      if (commands.some((command: any) => command?.name === commandName)) return undefined;
      return `Pi RPC does not expose /${commandName}. Only extension commands, prompt templates, and skills returned by /skills can be forwarded.`;
    } catch (error) {
      return this.friendlyError(error);
    }
  }

  private async ensureClient(): Promise<void> {
    if (this.destroyed) throw new Error('Executor has been destroyed');
    if (this.adopted && (!this.sessionFile || !fs.existsSync(this.sessionFile))) throw new Error(MISSING_ADOPTED_ERROR);
    assertWorkingDirectoryExists(this.currentWorkingDirectory);
    if (this.retiredClients.size > 0) {
      await Promise.all([...this.retiredClients].map(client => this.stopRetiredClient(client)));
    }
    if (this.destroyed) throw new Error('Executor has been destroyed');
    assertWorkingDirectoryExists(this.currentWorkingDirectory);
    if (!this.client.isRunning()) {
      this.reportedModel = undefined;
      this.reportedEffort = undefined;
      this.client.updateLaunch?.(this.buildLaunch());
      await this.client.start();
      if (!this.adopted) {
        await this.refreshSessionPointer();
        return;
      }
      // Adopted sessions never follow a silently substituted identity after a restart.
      const mismatch = await this.checkAdoptedIdentity({ sessionId: this.sessionId!, sessionFile: this.sessionFile! });
      if (mismatch) {
        await this.client.stop().catch(() => undefined);
        throw new Error(`${mismatch} ${MISSING_ADOPTED_ERROR}`);
      }
    }
  }

  /**
   * Connect this thread to an existing native Pi session file. Verification uses
   * RPC `get_state` only: no prompt is sent. Pi may append ordinary metadata
   * entries (for example a thinking-level record) but keeps prior history intact.
   */
  async adoptNativeSession(target: NativeSessionTarget): Promise<NativeSessionResult> {
    const fail = (error: string): NativeSessionResult => ({ success: false, error });
    if (this.destroyed) return fail('Executor has been destroyed.');
    if (this.isBusy()) return fail('Wait for the running Pi task to finish before connecting a session.');
    if (!fs.existsSync(target.sessionFile)) return fail('The selected Pi session is no longer available. No session was changed.');
    return this.mutateNativeSession(() => this.adoptIdleNativeSession(target));
  }

  private async mutateNativeSession(operation: () => Promise<NativeSessionResult>): Promise<NativeSessionResult> {
    this.nativeSessionMutation = true;
    this.nativeSessionMutationCancelled = false;
    let finish!: () => void;
    this.nativeSessionMutationDone = new Promise<void>(resolve => { finish = resolve; });
    try { return await operation(); }
    finally {
      this.nativeSessionMutation = false;
      this.nativeSessionMutationDone = null;
      finish();
    }
  }

  private async adoptIdleNativeSession(target: NativeSessionTarget): Promise<NativeSessionResult> {
    const fail = (error: string): NativeSessionResult => ({ success: false, error });
    const previous = { sessionId: this.sessionId, sessionFile: this.sessionFile, adopted: this.adopted,
      reportedModel: this.reportedModel, reportedEffort: this.reportedEffort };
    try {
      await this.recycleClient();
    } catch (error) {
      return fail(`Could not confirm that the current Pi process stopped (${this.friendlyError(error)}). No session was changed.`);
    }
    if (this.destroyed || this.nativeSessionMutationCancelled) return fail('Pi session connection was cancelled. No session was connected.');
    this.sessionId = target.sessionId;
    this.sessionFile = target.sessionFile;
    this.adopted = true;
    let error: string | undefined;
    try {
      assertWorkingDirectoryExists(this.currentWorkingDirectory);
      this.reportedModel = undefined;
      this.reportedEffort = undefined;
      this.client.updateLaunch?.(this.buildLaunch());
      await this.client.start();
      // PiClient.request() can start a process; never call it after cancellation.
      if (!this.destroyed && !this.nativeSessionMutationCancelled) error = await this.checkAdoptedIdentity(target);
      if (this.destroyed || this.nativeSessionMutationCancelled) error = 'Pi session connection was cancelled.';
      if (!error && !this.savePointer()) error = 'Could not persist the Pi session connection.';
    } catch (startError) {
      error = this.friendlyError(startError);
    }
    if (!error) {
      return { success: true };
    }
    let stopped = true;
    try { await this.client.stop(); } catch { stopped = false; }
    Object.assign(this, previous);
    // An unconfirmed stop is retired and retried before the previous session starts again.
    if (stopped) this.client.updateLaunch?.(this.buildLaunch());
    else this.replaceClient();
    return { success: false, error: `${error} The previous conversation is kept.${stopped ? '' : ' Selected Pi process exit could not be confirmed; the session remains reserved until recovery.'}`,
      ...(!stopped ? { recoveryRequired: true } : {}) };
  }

  /** Forget the adopted session without deleting it; the next turn starts a fresh conversation. */
  async detachNativeSession(): Promise<NativeSessionResult> {
    if (this.destroyed) return { success: false, error: 'Executor has been destroyed.' };
    if (!this.adopted) return { success: false, error: 'This thread is not connected to a native Pi session.' };
    if (this.isBusy()) return { success: false, error: 'Wait for the running Pi task to finish (or send /abort) before detaching the session.' };
    return this.mutateNativeSession(() => this.detachIdleNativeSession());
  }

  private async detachIdleNativeSession(): Promise<NativeSessionResult> {
    const previous = { sessionId: this.sessionId, sessionFile: this.sessionFile, adopted: this.adopted };
    try {
      await this.recycleClient();
    } catch (error) {
      return { success: false, error: `Could not confirm that the Pi process stopped (${this.friendlyError(error)}). The session is still connected; try again.` };
    }
    if (this.destroyed || this.nativeSessionMutationCancelled) return { success: false, error: 'Pi session detach was cancelled. The session is still connected.' };
    this.adopted = false;
    this.sessionFile = null;
    this.sessionId = randomUUID();
    if (!this.savePointer()) {
      Object.assign(this, previous);
      this.client.updateLaunch?.(this.buildLaunch());
      return { success: false, error: 'Could not persist the Pi session detach. The session is still connected; try again.' };
    }
    this.client.updateLaunch?.(this.buildLaunch());
    return { success: true };
  }

  /** Returns an error description when Pi did not load exactly the expected session. */
  private async checkAdoptedIdentity(expected: NativeSessionTarget): Promise<string | undefined> {
    const response = await this.client.request({ type: 'get_state' });
    const data = response.success ? response.data : undefined;
    if (!data) return 'Pi did not report its session state.';
    if (data.sessionId !== expected.sessionId || typeof data.sessionFile !== 'string'
      || !sameFilePath(data.sessionFile, expected.sessionFile)) {
      return 'Pi opened a different session than the one selected.';
    }
    if (data.isStreaming === true) return 'Pi reported that the session is already running a turn.';
    const model = data.model;
    if (typeof model?.id === 'string' && model.id.trim()) {
      this.reportedModel = typeof model.provider === 'string' && model.provider ? `${model.provider}/${model.id}` : model.id;
    }
    if (typeof data.thinkingLevel === 'string' && data.thinkingLevel.trim()) this.reportedEffort = data.thinkingLevel;
    return undefined;
  }

  private async recycleClient(): Promise<void> {
    await Promise.all([
      this.client.stop(),
      ...[...this.retiredClients].map(client => this.stopRetiredClient(client)),
    ]);
  }

  private async stopRetiredClient(client: PiTransport): Promise<void> {
    await client.stop();
    // Keep failed shutdowns owned by this executor across context resets.
    this.retiredClients.delete(client);
  }

  private replaceClient(): void {
    this.reportedModel = undefined;
    this.reportedEffort = undefined;
    this.unsubscribe?.();
    this.unsubscribe = null;
    const previous = this.client;
    this.retiredClients.add(previous);
    this.client = this.createClient(this.buildLaunch());
    this.unsubscribe = this.client.onEvent((event) => this.handleEvent(event));
    void this.stopRetiredClient(previous).catch((error) => {
      console.warn('[PiExecutor] Failed to stop previous Pi RPC process', error);
    });
  }

  private isForegroundSession(threadId = this.threadId): boolean {
    return !this.delegationWorker && !/^(?:remote-cli-)?(?:delegate-lane-|settings-meta-)/.test(threadId ?? '');
  }

  private forgetSession(): void {
    const sessionFile = this.sessionFile;
    const preserveHistory = this.adopted || this.isForegroundSession();
    this.clearPointer();
    // Reset changes the foreground association, never deletes resumable history.
    if (sessionFile && !preserveHistory) {
      try { fs.unlinkSync(sessionFile); } catch { /* ignore */ }
    }
  }

  private buildLaunch(): PiLaunchOptions {
    const pointerFile = this.sessionFile && fs.existsSync(this.sessionFile) ? this.sessionFile : undefined;
    // A cleared pointer must never reopen history through a reused runtime ID.
    const sessionId = this.sessionId ?? this.freshSessionId;
    return {
      command: this.piCommand,
      cwd: this.currentWorkingDirectory,
      approveProject: this.autoApprove,
      sessionDir: this.sessionStoreDir,
      sessionId,
      sessionFile: pointerFile,
      // Name fresh foreground sessions by native identity, not their reusable thread.
      // Never rename a persisted file on reopen, including locally assigned names.
      sessionName: this.threadId && !this.adopted
        ? this.isForegroundSession()
          ? !pointerFile ? `remote-cli-${sessionId}` : undefined
          : `remote-cli-${this.threadId}`
        : undefined,
      provider: this.provider,
      model: this.model,
      thinking: this.effort,
      delegation: this.delegation,
      delegationWorker: this.delegationWorker,
    };
  }

  private handleEvent(event: Record<string, any>): void {
    if (event.type === 'client_disconnected') {
      if (this.activeTurn) {
        this.completeActive({ success: false, error: event.error || 'Pi RPC process disconnected' });
      }
      return;
    }

    if (event.type === 'extension_ui_request') {
      void this.handleUiRequest(event);
      return;
    }

    const active = this.activeTurn;
    if (!active) return;

    // Pi is still working: re-arm the watchdog so many short tool calls cannot
    // exhaust it by cumulative duration.
    this.armInactivityTimer(active);

    if (event.type === 'agent_start') {
      active.sawAgentStart = true;
      return;
    }

    if (event.type === 'agent_end') {
      const error = extractAgentError(event);
      if (error) {
        if (event.willRetry) active.lastRetryError = error;
        else active.error = error;
      }
      if (!error && active.output.join('') === '') {
        const text = (Array.isArray(event.messages) ? event.messages : [])
          .filter((message: any) => message?.role === 'assistant')
          .map(extractMessageText)
          .join('');
        if (text) {
          active.output.push(text);
          active.options.onStream?.(text);
          active.options.onDisplayText?.(text);
        }
      }
      return;
    }

    if (event.type === 'agent_settled') {
      active.settle?.();
      return;
    }

    if (event.type === 'message_update') {
      const delta = event.assistantMessageEvent;
      if (delta?.type === 'text_delta' && typeof delta.delta === 'string') {
        active.output.push(delta.delta);
        active.options.onStream?.(delta.delta);
        active.options.onDisplayText?.(delta.delta);
        this.activityTracker.emitPublicText(delta.delta);
      }
      return;
    }

    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      if (typeof event.message.model === 'string' && event.message.model.trim()) {
        this.reportedModel = typeof event.message.provider === 'string' && event.message.provider
          ? `${event.message.provider}/${event.message.model}` : event.message.model;
      }
      const text = extractMessageText(event.message);
      if (text && active.output.join('') === '') {
        active.output.push(text);
        active.options.onStream?.(text);
        active.options.onDisplayText?.(text);
        this.activityTracker.emitPublicText(text);
      }
      return;
    }

    if (event.type === 'turn_end') {
      const text = extractMessageText(event.message);
      if (text && active.output.join('') === '') {
        active.output.push(text);
        active.options.onStream?.(text);
        active.options.onDisplayText?.(text);
        this.activityTracker.emitPublicText(text);
      }
      return;
    }

    if (event.type === 'tool_execution_start') {
      const mapped = mapPiTool(String(event.toolName ?? 'tool'), event.args);
      const id = event.toolCallId != null
        ? String(event.toolCallId)
        : `pi-fallback-${++active.nextToolFallbackId}`;
      if (event.toolCallId == null) active.pendingToolFallbackIds.push(id);
      active.options.onToolUse?.({
        id,
        name: mapped.name,
        input: mapped.input,
        ...(typeof event.args?.description === 'string' ? { description: event.args.description } : {}),
        ...(typeof event.args?.title === 'string' ? { title: event.args.title } : {}),
      });
      this.activityTracker.emitTool(mapped.name, mapped.input);
      return;
    }

    if (event.type === 'tool_execution_end') {
      // End events must reuse the id emitted at start; without toolCallId, pair
      // with the oldest unmatched fallback id so consumers tracking tool ids by
      // start/end pairs (e.g. delegation activity tracking) stay balanced.
      const toolUseId = event.toolCallId != null
        ? String(event.toolCallId)
        : active.pendingToolFallbackIds.shift() ?? mapPiTool(String(event.toolName ?? 'tool'), undefined).name;
      active.options.onToolResult?.({
        tool_use_id: toolUseId,
        content: toolResultText(event.result),
        is_error: Boolean(event.isError),
      });
      return;
    }

    if (event.type === 'extension_error') {
      const message = typeof event.error === 'string' && event.error.trim()
        ? event.error.trim()
        : 'Pi extension failed';
      active.error = message;
      return;
    }

    if (event.type === 'auto_retry_start') {
      if (event.errorMessage) active.lastRetryError = String(event.errorMessage);
      active.options.onStream?.(retryNotice(event));
      return;
    }

    if (event.type === 'auto_retry_end') {
      if (event.success === false) {
        active.error = String(event.finalError || active.lastRetryError || 'Pi retry failed');
      } else {
        active.lastRetryError = undefined;
      }
    }
  }

  private async handleUiRequest(event: Record<string, any>): Promise<void> {
    const id = String(event.id ?? '');
    const method = String(event.method ?? '');
    if (!id || !method) return;

    const fireAndForget = ['notify', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text'];
    if (fireAndForget.includes(method)) {
      if (this.activeTurn) this.armInactivityTimer(this.activeTurn);
      if (method === 'notify' && event.message) {
        this.activeTurn?.options.onStream?.(`\n${event.message}\n`);
      }
      return;
    }

    const options = Array.isArray(event.options) ? event.options.map(normalizeUiOption) : [];
    const title = String(event.title || event.message || 'Pi needs input');

    // Pi extension dialogs are application-defined. A confirm request may be
    // destructive (for example, clearing a session), so project trust must not
    // be treated as permission to accept arbitrary extension UI requests.
    if (!this.activeTurn) {
      this.client.send({ type: 'extension_ui_response', id, cancelled: true });
      return;
    }

    this.cancelPendingUi(true);
    let lines: string[];
    if (method === 'confirm') {
      lines = [`\n${title}`, 'Reply yes or no.\n'];
    } else if (method === 'select') {
      lines = [
        `\n${title}`,
        ...options.map((option, index) => `${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ''}`),
        'Reply with an option number, option name, skip, or cancel.\n',
      ];
    } else {
      lines = [`\n${title}`, 'Reply with a value, or send skip or cancel.\n'];
    }
    this.activeTurn?.options.onStream?.(lines.join('\n'));
    this.pendingUi = { id, method, title, options };
    // The turn now waits for a human, not for Pi; suspend the watchdog until the
    // reply re-arms it, so a slow answer is never reported as Pi inactivity. The
    // hard limit stays armed because it bounds the whole turn.
    if (this.activeTurn) this.clearInactivityTimer(this.activeTurn);
    this.schedulePendingUiExpiry(id, event.timeout);
  }

  /**
   * Pi resolves a dialog that carries its own timeout and sends no event for it.
   * Without this the watchdog would stay suspended for the rest of the turn.
   */
  private schedulePendingUiExpiry(id: string, timeoutMs: unknown): void {
    this.clearPendingUiExpiry();
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return;
    this.pendingUiExpiry = setTimeout(() => {
      this.pendingUiExpiry = null;
      if (this.pendingUi?.id !== id) return;
      this.pendingUi = null;
      if (this.activeTurn) this.armInactivityTimer(this.activeTurn);
    }, timeoutMs);
  }

  private clearPendingUiExpiry(): void {
    if (this.pendingUiExpiry) clearTimeout(this.pendingUiExpiry);
    this.pendingUiExpiry = null;
  }

  private async resolveModel(value: string): Promise<{ provider?: string; modelId: string } | null> {
    const parsed = parsePiModelRef(value);
    try {
      const models = await this.listModels();
      const exact = models.find((model) => model.id === value || model.id === formatPiModelRef({ id: parsed.modelId, provider: parsed.provider }));
      if (exact) return parsePiModelRef(exact.id);
      const byId = models.find((model) => parsePiModelRef(model.id).modelId === parsed.modelId);
      if (byId) return parsePiModelRef(byId.id);
    } catch {
      // Fall through to the caller-supplied ref when the catalog is unavailable.
    }
    return parsed.modelId ? parsed : null;
  }

  private async isSessionStreaming(): Promise<boolean> {
    try {
      const response = await this.client.request({ type: 'get_state' });
      return Boolean(response.data?.isStreaming);
    } catch {
      return false;
    }
  }

  private async lastAssistantText(): Promise<string> {
    try {
      const response = await this.client.request({ type: 'get_last_assistant_text' });
      return typeof response.data?.text === 'string' ? response.data.text : '';
    } catch {
      return '';
    }
  }

  private async refreshSessionPointer(): Promise<void> {
    try {
      const response = await this.client.request({ type: 'get_state' });
      if (response.success && response.data) {
        const model = response.data.model;
        if (typeof model?.id === 'string' && model.id.trim()) {
          this.reportedModel = typeof model.provider === 'string' && model.provider
            ? `${model.provider}/${model.id}` : model.id;
        }
        if (typeof response.data.thinkingLevel === 'string' && response.data.thinkingLevel.trim()) this.reportedEffort = response.data.thinkingLevel;
        if (typeof response.data.sessionId === 'string') this.sessionId = response.data.sessionId;
        if (typeof response.data.sessionFile === 'string') this.sessionFile = response.data.sessionFile;
        this.savePointer();
      }
    } catch (error) {
      console.warn('[PiExecutor] Failed to refresh Pi session pointer', error);
    }
  }

  private loadPointer(): void {
    try {
      const stored = JSON.parse(fs.readFileSync(this.sessionFilePath, 'utf8')) as SessionPointer;
      if (stored.cwd && stored.cwd !== this.currentWorkingDirectory) {
        this.clearPointer();
        return;
      }
      if (stored.id) this.sessionId = stored.id;
      if (stored.sessionFile) this.sessionFile = stored.sessionFile;
      this.adopted = stored.adopted === true;
      // Legacy released flags no longer gate adopted sessions.
    } catch {
      // First run for this thread.
    }
  }

  private savePointer(): boolean {
    const pointer: SessionPointer = {
      id: this.sessionId ?? undefined,
      sessionFile: this.sessionFile ?? undefined,
      cwd: this.currentWorkingDirectory,
      ...(this.adopted ? { adopted: true } : {}),
    };
    const temporaryPath = `${this.sessionFilePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify(pointer), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporaryPath, this.sessionFilePath);
      return true;
    } catch (error) {
      try { fs.unlinkSync(temporaryPath); } catch { /* ignore */ }
      console.warn('[PiExecutor] Failed to save Pi session pointer', error);
      return false;
    }
  }

  private clearPointer(): void {
    this.sessionId = null;
    this.sessionFile = null;
    this.adopted = false;
    this.freshSessionId = randomUUID();
    try { fs.unlinkSync(this.sessionFilePath); } catch { /* ignore */ }
  }

  private completeActive(result: ExecuteResult): void {
    const active = this.activeTurn;
    if (!active) return;
    this.activeTurn = null;
    this.activityTracker.reset();
    this.activityTracker.setCallback(undefined);
    if (active.timeoutTimer) clearTimeout(active.timeoutTimer);
    if (active.inactivityTimer) clearTimeout(active.inactivityTimer);
    active.settle?.();
    this.cancelPendingUi(true);
    // A claimed failure wins over any later result: Pi's own aborted turn would
    // otherwise report a successful turn that merely raced the deadline.
    active.resolve(active.programError
      ? { ...result, success: false, error: active.programError }
      : result);
  }

  /** Arm the one-shot hard deadline and the re-armable inactivity watchdog. */
  private armTurnDeadlines(active: ActiveTurn): void {
    const requested = active.options.timeout;
    // A non-finite or non-positive limit has no meaningful deadline; Node would
    // otherwise clamp Infinity to an immediate timer.
    if (typeof requested === 'number' && Number.isFinite(requested) && requested > 0) {
      active.timeoutTimer = setTimeout(() => {
        this.startFailure(active, `Pi turn timed out after ${requested}ms (hard time limit)`);
      }, requested);
    }
    this.armInactivityTimer(active);
  }

  /** Claim the turn once; the in-flight cleanup stays observable to /abort. */
  private startFailure(active: ActiveTurn, error: string): void {
    const failing = this.failActive(active, error);
    active.failing = failing;
    void failing;
  }

  /** Clear both deadlines; the turn either settled or already claimed a failure. */
  private clearTurnTimers(active: ActiveTurn): void {
    if (active.timeoutTimer) {
      clearTimeout(active.timeoutTimer);
      active.timeoutTimer = undefined;
    }
    this.clearInactivityTimer(active);
  }

  /** Clear only the inactivity watchdog; a hard deadline keeps running. */
  private clearInactivityTimer(active: ActiveTurn): void {
    if (active.inactivityTimer) clearTimeout(active.inactivityTimer);
    active.inactivityTimer = undefined;
  }

  /**
   * Arm or re-arm the inactivity watchdog. `inactivityTimeout: 0` disables it
   * (used by delegated workers, whose manager owns liveness).
   */
  private armInactivityTimer(active: ActiveTurn): void {
    // A claimed failure is already aborting this turn; do not re-arm behind it.
    if (active.programError) return;
    if (this.pendingUi) {
      // A turn blocked on a user answer is not idle; the reply re-arms it. Only
      // the watchdog pauses: a caller-supplied hard limit still runs.
      this.clearInactivityTimer(active);
      return;
    }
    const requested = active.options.inactivityTimeout ?? this.inactivityTimeoutMs;
    if (active.inactivityTimer) clearTimeout(active.inactivityTimer);
    active.inactivityTimer = undefined;
    if (!Number.isFinite(requested) || requested <= 0) return;
    active.inactivityTimer = setTimeout(() => {
      this.startFailure(active, `Pi turn timed out after ${requested}ms of inactivity (no output or tool events)`);
    }, requested);
  }

  private async failActive(active: ActiveTurn, error: string): Promise<void> {
    // Claim the turn once: an event arriving while the abort RPC is in flight
    // must not start a second failure or a duplicate abort.
    if (this.activeTurn !== active || active.programError) return;
    // Claim the reason before the RPC: Pi answers `abort` only after it persists
    // its own aborted turn, and that event settles this turn first.
    active.programError = error;
    this.clearTurnTimers(active);
    let cleanupError: unknown;
    try {
      await this.client.request({ type: 'abort' });
    } catch {
      // Only the turn that still owns the session may recycle its transport; a
      // late failure from a settled turn must not stop the next turn's client.
      if (this.activeTurn === active) {
        try { await this.recycleClient(); }
        catch (failure) { cleanupError = failure; }
      }
    }
    if (this.activeTurn === active) {
      if (cleanupError) active.programError = `${active.programError}; ${this.friendlyError(cleanupError)}`;
      this.completeActive({ success: false, error: active.programError, sessionAbbr: this.sessionAbbr() });
    }
  }

  private cancelPendingUi(cancel = false): void {
    const pending = this.pendingUi;
    this.pendingUi = null;
    this.clearPendingUiExpiry();
    if (pending && cancel) {
      try {
        this.client.send({ type: 'extension_ui_response', id: pending.id, cancelled: true });
      } catch {
        // Process may already be gone.
      }
    }
  }

  private toImages(attachments?: Attachment[]): Array<{ type: 'image'; data: string; mimeType: string }> {
    return (attachments ?? [])
      .filter((attachment) => attachment.type === 'image')
      .map((attachment) => ({ type: 'image' as const, data: attachment.data, mimeType: attachment.mimeType }));
  }

  private sessionAbbr(): string | undefined {
    return this.sessionId ? this.sessionId.slice(0, 8) : undefined;
  }

  private friendlyError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    // Match ENOENT only: broader phrases such as "not found on PATH" also match a
    // message that embeds a working-directory path containing that text, which
    // would mislabel the directory error as a missing executable.
    if (/ENOENT/i.test(message)) {
      return `Pi CLI is not installed or not found on PATH. Install it with \`${INSTALL_COMMAND}\`, authenticate with \`pi\`, or use /backend to switch backends.`;
    }
    return message;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type { PiRpcResponse };
