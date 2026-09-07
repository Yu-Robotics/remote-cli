import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DirectoryGuard } from '../security/DirectoryGuard';
import type { Attachment } from '../types';
import type { ExecuteOptions, ExecuteResult, ExecutorModelInfo, IExecutor } from './IExecutor';
import { AppServerMessage, CodexAppServerClient } from './CodexAppServerClient';

export interface CodexAppServerTransport {
  start(): Promise<void>;
  request(method: string, params?: any, timeoutMs?: number): Promise<any>;
  respond(id: number | string, result: any): void;
  respondError(id: number | string, message: string, code?: number): void;
  onMessage(handler: (message: AppServerMessage) => void): () => void;
  stop(): Promise<void>;
  isRunning(): boolean;
  setWorkingDirectory(cwd: string): void;
}

export interface CodexAppServerExecutorOptions {
  model?: string;
  autoApprove?: boolean;
  initialWorkingDirectory?: string;
  codexCommand?: string;
  threadId?: string;
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
  emittedTools: Set<string>;
  temporaryFiles: string[];
  timeoutTimer?: ReturnType<typeof setTimeout>;
}

interface CompactWaiter {
  resolve: (result: ExecuteResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingUserInput {
  id: number | string;
  method: string;
  params: any;
}

const DEFAULT_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_COMPACT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Persistent Codex executor backed by the official app-server protocol.
 * One instance is owned by one remote-cli thread, preserving the existing
 * ThreadExecutorPool isolation model.
 */
export class CodexAppServerExecutor implements IExecutor {
  private readonly directoryGuard: DirectoryGuard;
  private currentWorkingDirectory: string;
  private model?: string;
  private readonly autoApprove: boolean;
  private readonly remoteThreadId?: string;
  private readonly sessionFilePath: string;
  private readonly inactivityTimeoutMs: number;
  private readonly compactTimeoutMs: number;
  private readonly client: CodexAppServerTransport;
  private unsubscribeClient: (() => void) | null = null;

  private codexThreadId: string | null = null;
  private threadReady = false;
  private activeTurn: ActiveTurn | null = null;
  private compactWaiter: CompactWaiter | null = null;
  private pendingUserInputs: PendingUserInput[] = [];
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(directoryGuard: DirectoryGuard, options: CodexAppServerExecutorOptions = {}) {
    this.directoryGuard = directoryGuard;
    this.model = options.model;
    this.autoApprove = options.autoApprove ?? true;
    this.remoteThreadId = options.threadId;
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
        });
    this.unsubscribeClient = this.client.onMessage((message) => this.handleMessage(message));
  }

  async execute(prompt: string, options: ExecuteOptions = {}): Promise<ExecuteResult> {
    if (this.destroyed) throw new Error('Executor has been destroyed');
    if (this.activeTurn || this.compactWaiter) {
      return { success: false, error: 'Codex thread is already running a command' };
    }

    try {
      await this.ensureThread();
    } catch (error) {
      return { success: false, error: this.errorMessage(error) };
    }

    const temporaryFiles: string[] = [];
    try {
      const input = await this.buildInput(prompt, options.attachments, temporaryFiles);
      return await new Promise<ExecuteResult>((resolve) => {
        const active: ActiveTurn = {
          options,
          resolve,
          turnId: null,
          output: [],
          sideEffectsStarted: false,
          emittedTools: new Set(),
          temporaryFiles,
        };
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
          ...(this.autoApprove ? {
            approvalPolicy: 'never',
            sandboxPolicy: { type: 'dangerFullAccess' },
          } : {}),
        };

        void this.client.request('turn/start', params).then((response) => {
          if (this.activeTurn !== active) return;
          const turnId = response?.turn?.id;
          if (typeof turnId !== 'string' || !turnId) {
            this.completeActive({ success: false, error: 'Codex app-server returned no turn ID' });
            return;
          }
          active.turnId = turnId;
        }).catch((error) => {
          if (this.activeTurn === active) {
            this.completeActive({ success: false, error: this.errorMessage(error) });
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

  async setWorkingDirectory(targetPath: string): Promise<void> {
    this.currentWorkingDirectory = this.directoryGuard.resolveWorkingDirectory(
      targetPath,
      this.currentWorkingDirectory
    );
    this.client.setWorkingDirectory(this.currentWorkingDirectory);
  }

  resetContext(): void {
    const previousId = this.codexThreadId;
    if (this.activeTurn || this.compactWaiter) {
      this.completeActive({ success: false, error: 'Conversation cleared by user' });
      this.completeCompact({ success: false, error: 'Conversation cleared by user' });
      void this.client.stop();
    }
    this.codexThreadId = null;
    this.threadReady = false;
    this.pendingUserInputs = [];
    this.clearThreadId();
    if (previousId && this.client.isRunning()) {
      void this.client.request('thread/unsubscribe', { threadId: previousId }).catch(() => undefined);
    }
  }

  async abort(): Promise<boolean> {
    const active = this.activeTurn;
    if (!active || !this.codexThreadId) return false;

    for (const pending of this.pendingUserInputs.splice(0)) {
      this.client.respond(
        pending.id,
        pending.method === 'item/tool/requestUserInput'
          ? { answers: {} }
          : { decision: 'cancel' }
      );
    }

    if (!active.turnId) {
      await this.failAndRestart('Aborted by user');
      return true;
    }

    try {
      await this.client.request('turn/interrupt', {
        threadId: this.codexThreadId,
        turnId: active.turnId,
      });
    } catch {
      await this.failAndRestart('Aborted by user');
    }
    return true;
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unsubscribeClient?.();
    this.unsubscribeClient = null;
    if (this.activeTurn) this.completeActive({ success: false, error: 'Executor destroyed' });
    this.completeCompact({ success: false, error: 'Executor destroyed' });
    await this.client.stop();
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
    return true;
  }

  async listModels(): Promise<ExecutorModelInfo[]> {
    const models: ExecutorModelInfo[] = [];
    let cursor: string | null = null;
    do {
      const response = await this.client.request('model/list', {
        cursor,
        limit: 100,
        includeHidden: false,
      });
      for (const model of Array.isArray(response?.data) ? response.data : []) {
        if (typeof model?.id !== 'string') continue;
        models.push({
          id: model.id,
          displayName: model.displayName ?? model.id,
          description: model.description,
          isDefault: model.isDefault === true,
          supportedReasoningEfforts: Array.isArray(model.supportedReasoningEfforts)
            ? model.supportedReasoningEfforts.map((entry: any) => entry?.reasoningEffort).filter(Boolean)
            : undefined,
          inputModalities: Array.isArray(model.inputModalities) ? model.inputModalities : undefined,
        });
      }
      cursor = typeof response?.nextCursor === 'string' ? response.nextCursor : null;
    } while (cursor);
    return models;
  }

  async setModel(model: string): Promise<ExecuteResult> {
    try {
      const models = await this.listModels();
      if (!models.some((entry) => entry.id === model)) {
        return { success: false, error: `Unknown Codex model: ${model}. Use /model to list available models.` };
      }
      this.model = model;
      return { success: true, output: `Model set to ${model}. Takes effect on the next command.` };
    } catch (error) {
      return { success: false, error: this.errorMessage(error) };
    }
  }

  clearModel(): void {
    this.model = undefined;
  }

  async compactWhenFull(_onStream?: (chunk: string) => void): Promise<ExecuteResult> {
    if (!this.codexThreadId) return { success: true, output: 'No active conversation to compact.' };
    if (this.activeTurn || this.compactWaiter) {
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
  }

  private async ensureThread(): Promise<void> {
    if (this.threadReady && this.client.isRunning()) return;
    await this.client.start();

    const common: any = {
      ...(this.model ? { model: this.model } : {}),
      cwd: this.currentWorkingDirectory,
      ...(this.autoApprove ? {
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
      } : {}),
    };

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
      } catch (error) {
        throw new Error(`Stored Codex thread could not be resumed: ${this.errorMessage(error)}. Use /clear to start fresh.`);
      }
    } else {
      const response = await this.client.request('thread/start', {
        ...common,
        serviceName: 'remote_cli',
      });
      const id = response?.thread?.id;
      if (typeof id !== 'string' || !id) throw new Error('Codex app-server returned no thread ID');
      this.setThreadId(id);
    }
    this.threadReady = true;
  }

  private handleMessage(message: AppServerMessage): void {
    const method = message.method;
    if (!method) return;
    const params = message.params ?? {};

    if (method === 'client/disconnected') {
      this.threadReady = false;
      if (this.activeTurn) {
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
    if (this.activeTurn) this.armInactivityTimer();

    switch (method) {
      case 'turn/started':
        if (this.activeTurn && typeof params.turn?.id === 'string') this.activeTurn.turnId = params.turn.id;
        break;
      case 'item/agentMessage/delta':
        if (this.activeTurn && typeof params.delta === 'string') {
          this.activeTurn.output.push(params.delta);
          this.activeTurn.options.onStream?.(params.delta);
        }
        break;
      case 'item/reasoning/summaryTextDelta':
        if (this.activeTurn && typeof params.delta === 'string') {
          this.activeTurn.options.onStream?.(params.delta);
        }
        break;
      case 'turn/plan/updated':
        if (this.activeTurn && Array.isArray(params.plan)) {
          const plan = params.plan.map((entry: any) => `${entry.status === 'completed' ? '✅' : entry.status === 'inProgress' ? '🔄' : '⬜'} ${entry.step}`).join('\n');
          if (plan) this.activeTurn.options.onPlanMode?.(plan);
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

  private handleServerRequest(id: number | string, method: string, params: any): void {
    if (params.threadId && params.threadId !== this.codexThreadId) {
      this.client.respondError(id, 'Request does not belong to this remote-cli thread');
      return;
    }
    this.armInactivityTimer();

    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      if (this.autoApprove) {
        this.client.respond(id, { decision: 'accept' });
        return;
      }
      this.pendingUserInputs.push({ id, method, params });
      const subject = method.includes('commandExecution')
        ? params.command ?? params.reason ?? 'command execution'
        : params.reason ?? params.grantRoot ?? 'file changes';
      this.activeTurn?.options.onStream?.(`\nApproval required for ${subject}. Reply yes, always, no, or cancel.\n`);
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

    switch (item.type) {
      case 'commandExecution':
        active.sideEffectsStarted = true;
        this.emitToolUse(active, id, 'Bash', { command: item.command ?? '' });
        break;
      case 'fileChange':
        active.sideEffectsStarted = true;
        this.emitToolUse(active, id, 'Edit', { file_path: item.changes?.[0]?.path ?? '' });
        break;
      case 'webSearch':
        this.emitToolUse(active, id, 'WebSearch', { query: item.query ?? '' });
        break;
      case 'mcpToolCall':
      case 'dynamicToolCall':
        active.sideEffectsStarted = true;
        this.emitToolUse(active, id, item.tool ?? 'MCP', item.arguments ?? {});
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

    switch (item.type) {
      case 'commandExecution':
        this.emitToolUse(active, id, 'Bash', { command: item.command ?? '' });
        active.options.onToolResult?.({
          tool_use_id: id,
          content: item.aggregatedOutput ?? '',
          is_error: item.status !== 'completed' || (typeof item.exitCode === 'number' && item.exitCode !== 0),
        });
        break;
      case 'fileChange': {
        this.emitToolUse(active, id, 'Edit', { file_path: item.changes?.[0]?.path ?? '' });
        const changes = Array.isArray(item.changes) ? item.changes : [];
        active.options.onToolResult?.({
          tool_use_id: id,
          content: changes.map((change: any) => `${change.kind ?? 'update'}: ${change.path ?? ''}`).join('\n'),
          is_error: item.status !== 'completed',
        });
        break;
      }
      case 'webSearch':
        this.emitToolUse(active, id, 'WebSearch', { query: item.query ?? '' });
        active.options.onToolResult?.({ tool_use_id: id, content: '', is_error: false });
        break;
      case 'mcpToolCall':
      case 'dynamicToolCall':
        this.emitToolUse(active, id, item.tool ?? 'MCP', item.arguments ?? {});
        active.options.onToolResult?.({
          tool_use_id: id,
          content: this.stringifyResult(item.result ?? item.contentItems ?? item.error ?? ''),
          is_error: item.status !== 'completed' || item.success === false || Boolean(item.error),
        });
        break;
      case 'plan':
        if (typeof item.text === 'string' && item.text) active.options.onPlanMode?.(item.text);
        break;
      default:
        break;
    }
  }

  private handleTurnCompleted(turn: any): void {
    const active = this.activeTurn;
    if (!active || !turn) return;
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

  private emitToolUse(active: ActiveTurn, id: string, name: string, input: Record<string, any>): void {
    if (active.emittedTools.has(id)) return;
    active.emittedTools.add(id);
    active.options.onToolUse?.({ id, name, input });
  }

  private completeActive(result: ExecuteResult): void {
    const active = this.activeTurn;
    if (!active) return;
    this.activeTurn = null;
    this.pendingUserInputs = [];
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
    this.threadReady = false;
    this.completeActive({ success: false, error });
    this.completeCompact({ success: false, error });
    await this.client.stop();
  }

  private armInactivityTimer(): void {
    this.clearInactivityTimer();
    if (!this.activeTurn) return;
    this.inactivityTimer = setTimeout(() => {
      void this.failAndRestart(`No output from Codex for ${this.inactivityTimeoutMs}ms (inactivity timeout)`);
    }, this.inactivityTimeoutMs);
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
    } catch {
      this.codexThreadId = null;
    }
  }

  private setThreadId(id: string): void {
    this.codexThreadId = id;
    const temporaryPath = `${this.sessionFilePath}.${process.pid}.tmp`;
    const data = JSON.stringify({ id, savedAt: new Date().toISOString() });
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

  private extractErrorCode(info: any): string | undefined {
    if (typeof info === 'string') return info;
    if (!info || typeof info !== 'object') return undefined;
    if (typeof info.type === 'string') return info.type;
    return Object.keys(info)[0];
  }

  private stringifyResult(value: any): string {
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value).slice(0, 2_000);
    } catch {
      return String(value);
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
