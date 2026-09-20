import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DirectoryGuard } from '../security/DirectoryGuard';
import type { ExecuteOptions, ExecuteResult, ExecutorModelInfo, IExecutor } from './IExecutor';
import { AcpClient, type AcpEventCallbacks, type AcpToolCallUpdate, type AcpTransport } from './acp/AcpClient';
import type { AcpConfigOption, AcpContentBlock, AcpPermissionOption, AcpSessionResult } from './acp/AcpTypes';

const CANCEL_GRACE_MS = 3_000;

export interface AcpExecutorOptions {
  model?: string;
  effort?: string;
  autoApprove?: boolean;
  initialWorkingDirectory?: string;
  acpCommand: string;
  acpArgs: string[];
  backendLabel: string;
  sessionNamespace: string;
  effortConfigId: string;
  effortAutoValue: string;
  installCommand: string;
  authCommand: string;
  threadId?: string;
  /** Override session pointer storage for isolated tests. */
  sessionBaseDir?: string;
  clientFactory?: (callbacks: AcpEventCallbacks, cwd: string) => AcpTransport;
}

interface QueuedCommand {
  prompt: string;
  options: ExecuteOptions;
  resolve: (result: ExecuteResult) => void;
  reject: (error: Error) => void;
}

interface ActiveCallbacks {
  onStream?: (chunk: string) => void;
  onToolUse?: ExecuteOptions['onToolUse'];
  onToolResult?: ExecuteOptions['onToolResult'];
  onPlanMode?: ExecuteOptions['onPlanMode'];
  onImage?: ExecuteOptions['onImage'];
}

interface PendingPermission {
  title: string;
  options: AcpPermissionOption[];
  isQuestion: boolean;
  resolve: (index: number) => void;
}

function mapAcpToolCall(tool: AcpToolCallUpdate): { name: string; input: Record<string, unknown> } {
  if (tool.rawInput && typeof tool.rawInput === 'object' && !Array.isArray(tool.rawInput)) {
    return { name: mapAcpToolName(tool.kind, tool.title), input: tool.rawInput as Record<string, unknown> };
  }
  const title = tool.title ?? tool.toolCallId;
  const key = tool.kind === 'read' || tool.kind === 'write' ? 'file_path'
    : tool.kind === 'list' ? 'pattern'
      : 'command';
  return { name: mapAcpToolName(tool.kind, tool.title), input: { [key]: title } };
}

function mapAcpToolName(kind?: string, title?: string): string {
  if (kind === 'execute' || kind === 'exec') return 'Bash';
  if (kind === 'read') return 'Read';
  if (kind === 'write' || kind === 'edit') return 'Edit';
  if (kind === 'list' || kind === 'search') return 'Glob';
  return kind || title || 'Tool';
}

function acpToolResult(tool: AcpToolCallUpdate): { content: string; diff?: string } {
  const text: string[] = [];
  const diffs: string[] = [];
  for (const block of tool.content ?? []) {
    if (block.type === 'text') text.push(String(block.text ?? ''));
    else if (block.type === 'content' && block.content && typeof block.content === 'object') {
      const nested = block.content as Record<string, unknown>;
      if (nested.type === 'text') text.push(String(nested.text ?? ''));
      else text.push(JSON.stringify(nested));
    } else if (block.type === 'diff') {
      const filePath = String(block.path ?? 'file');
      const oldText = String(block.oldText ?? '');
      const newText = String(block.newText ?? '');
      diffs.push([
        `--- a/${filePath}`,
        `+++ b/${filePath}`,
        ...oldText.split('\n').map((line) => `-${line}`),
        ...newText.split('\n').map((line) => `+${line}`),
      ].join('\n'));
    } else if ('resource' in block) text.push(JSON.stringify(block.resource));
  }
  if (text.length === 0 && tool.rawOutput !== undefined) {
    text.push(typeof tool.rawOutput === 'string' ? tool.rawOutput : JSON.stringify(tool.rawOutput));
  }
  return { content: text.filter(Boolean).join('\n'), ...(diffs.length ? { diff: diffs.join('\n') } : {}) };
}

/** Shared executor implementation for CLI backends that expose ACP over stdio. */
export abstract class AcpExecutor implements IExecutor {
  private readonly directoryGuard: DirectoryGuard;
  private readonly autoApprove: boolean;
  private readonly threadId?: string;
  private readonly backendLabel: string;
  private readonly effortConfigId: string;
  private readonly effortAutoValue: string;
  private readonly installCommand: string;
  private readonly authCommand: string;
  private readonly sessionFilePath: string;
  private readonly clientFactory: (callbacks: AcpEventCallbacks, cwd: string) => AcpTransport;
  private currentWorkingDirectory: string;
  private model?: string;
  private effort?: string;
  private client: AcpTransport | null = null;
  private sessionId: string | null = null;
  private configOptions: AcpConfigOption[] = [];
  private activeCallbacks: ActiveCallbacks = {};
  private commandQueue: QueuedCommand[] = [];
  private isProcessing = false;
  private isDestroyed = false;
  private abortTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPermission: PendingPermission | null = null;
  private activeToolCalls = new Map<string, AcpToolCallUpdate>();

  protected constructor(directoryGuard: DirectoryGuard, options: AcpExecutorOptions) {
    this.directoryGuard = directoryGuard;
    this.model = options.model;
    this.effort = options.effort;
    this.autoApprove = options.autoApprove ?? true;
    this.threadId = options.threadId;
    this.backendLabel = options.backendLabel;
    this.effortConfigId = options.effortConfigId;
    this.effortAutoValue = options.effortAutoValue;
    this.installCommand = options.installCommand;
    this.authCommand = options.authCommand;
    const command = options.acpCommand;
    const args = options.acpArgs;
    this.clientFactory = options.clientFactory
      ?? ((callbacks, cwd) => new AcpClient(command, args, cwd, callbacks));

    try {
      this.currentWorkingDirectory = options.initialWorkingDirectory
        ? this.directoryGuard.resolveWorkingDirectory(options.initialWorkingDirectory)
        : process.cwd();
    } catch (error) {
      console.warn(`[${this.backendLabel}Executor] Failed to use initial working directory`, error);
      this.currentWorkingDirectory = process.cwd();
    }

    const sessionsDir = options.sessionBaseDir
      ?? path.join(os.homedir(), '.remote-cli', options.sessionNamespace);
    fs.mkdirSync(sessionsDir, { recursive: true });
    this.sessionFilePath = path.join(sessionsDir, `${this.threadId ?? 'default'}.json`);
    this.loadSessionPointer();
  }

  execute(prompt: string, options: ExecuteOptions = {}): Promise<ExecuteResult> {
    if (this.isDestroyed) return Promise.reject(new Error('Executor has been destroyed'));
    return new Promise((resolve, reject) => {
      this.commandQueue.push({ prompt, options, resolve, reject });
      void this.processQueue();
    });
  }

  getCurrentWorkingDirectory(): string {
    return this.currentWorkingDirectory;
  }

  async setWorkingDirectory(targetPath: string): Promise<void> {
    const resolved = this.directoryGuard.resolveWorkingDirectory(targetPath);
    if (resolved === this.currentWorkingDirectory) return;
    this.currentWorkingDirectory = resolved;
    this.destroyClient();
    this.clearSessionPointer();
  }

  resetContext(): void {
    this.cancelPendingPermission();
    this.destroyClient();
    this.clearSessionPointer();
  }

  async abort(): Promise<boolean> {
    if (!this.client || !this.sessionId || !this.isProcessing) return false;
    this.cancelPendingPermission();
    this.client.sendCancel(this.sessionId);
    this.clearAbortTimer();
    const client = this.client;
    this.abortTimer = setTimeout(() => {
      if (this.client === client && this.isProcessing) this.destroyClient();
    }, CANCEL_GRACE_MS);
    this.abortTimer.unref?.();
    return true;
  }

  async destroy(): Promise<void> {
    if (this.isDestroyed) return;
    this.isDestroyed = true;
    const queued = this.commandQueue.splice(0);
    for (const command of queued) command.reject(new Error('Executor has been destroyed'));
    this.cancelPendingPermission();
    this.destroyClient();
  }

  isWaitingInput(): boolean {
    return this.pendingPermission !== null;
  }

  sendInput(input: string): boolean {
    const pending = this.pendingPermission;
    if (!pending) return false;
    const normalized = input.trim().toLowerCase();
    if (pending.isQuestion) {
      const cancelIndex = pending.options.findIndex((option) => option.kind.startsWith('reject'));
      if (normalized === 'cancel' || normalized === 'skip') {
        this.pendingPermission = null;
        pending.resolve(cancelIndex);
        return true;
      }
      const numeric = Number.parseInt(normalized, 10);
      const index = Number.isInteger(numeric) && numeric > 0
        ? pending.options.findIndex((option, optionIndex) => optionIndex === numeric - 1 && option.kind.startsWith('allow'))
        : pending.options.findIndex((option) => option.kind.startsWith('allow')
          && (option.name?.trim().toLowerCase() === normalized || option.optionId.toLowerCase() === normalized));
      if (index < 0) return false;
      this.pendingPermission = null;
      pending.resolve(index);
      return true;
    }
    const kind = normalized === 'always' ? 'allow_always'
      : normalized === 'yes' || normalized === 'y' || normalized === 'accept' ? 'allow_once'
        : normalized === 'no' || normalized === 'n' || normalized === 'decline' ? 'reject_once'
          : normalized === 'cancel' ? null
            : undefined;
    if (kind === undefined) return false;
    this.pendingPermission = null;
    if (kind === null) {
      pending.resolve(-1);
      return true;
    }
    let index = pending.options.findIndex((option) => option.kind === kind);
    if (index < 0 && kind === 'allow_once') index = pending.options.findIndex((option) => option.kind.startsWith('allow'));
    if (index < 0 && kind === 'reject_once') index = pending.options.findIndex((option) => option.kind.startsWith('reject'));
    pending.resolve(index);
    return true;
  }

  isProcessRunning(): boolean {
    return this.client !== null;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  async listModels(): Promise<ExecutorModelInfo[]> {
    await this.ensureSession();
    const modelOption = this.findConfigOption('model');
    const effortOption = this.findConfigOption(this.effortConfigId);
    return (modelOption?.options ?? []).map((entry) => ({
      id: entry.value,
      displayName: entry.name,
      description: entry.description,
      isDefault: entry.value === modelOption?.currentValue,
      supportedReasoningEfforts: entry.value === modelOption?.currentValue
        ? effortOption?.options?.map((option) => option.value)
        : undefined,
      defaultReasoningEffort: entry.value === modelOption?.currentValue ? 'default' : undefined,
      inputModalities: ['text', 'image'],
    }));
  }

  async setModel(model: string): Promise<ExecuteResult> {
    const { client, sessionId } = await this.ensureSession();
    const option = this.findConfigOption('model');
    if (option?.options?.length && !option.options.some((entry) => entry.value === model)) {
      return { success: false, error: `Unknown ${this.backendLabel} model: ${model}. Use /model to list available models.` };
    }
    try {
      this.updateConfigOptions(await client.setConfigOption(sessionId, 'model', model));
      this.model = model;
      return { success: true, output: `Model set to ${model}.` };
    } catch (error) {
      return { success: false, error: this.friendlyError(error) };
    }
  }

  async setEffort(effort: string): Promise<ExecuteResult> {
    const { client, sessionId } = await this.ensureSession();
    const value = effort === 'auto' ? this.effortAutoValue : effort;
    const option = this.findConfigOption(this.effortConfigId);
    if (!option) return { success: false, error: `The selected ${this.backendLabel} model does not expose reasoning effort controls.` };
    if (effort !== 'auto' && option.options?.length && !option.options.some((entry) => entry.value === value)) {
      return { success: false, error: `Unsupported ${this.backendLabel} reasoning effort: ${effort}.` };
    }
    try {
      this.updateConfigOptions(await client.setConfigOption(sessionId, this.effortConfigId, value));
      this.effort = effort === 'auto' ? undefined : effort;
      return { success: true, output: `Reasoning effort set to ${effort}.` };
    } catch (error) {
      return { success: false, error: this.friendlyError(error) };
    }
  }

  async compactWhenFull(onStream?: (chunk: string) => void): Promise<ExecuteResult> {
    return this.execute('/compact', { onStream });
  }

  async deleteThreadData(_threadId: string): Promise<void> {
    const stored = this.sessionId;
    try {
      if (stored) {
        const { client } = await this.ensureSession();
        await client.deleteSession(stored);
      }
    } catch (error) {
      console.warn(`[${this.backendLabel}Executor] Failed to delete session`, error);
    } finally {
      this.destroyClient();
      this.clearSessionPointer();
    }
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.commandQueue.length === 0) return;
    const command = this.commandQueue.shift()!;
    this.isProcessing = true;
    try {
      command.resolve(await this.executeQueued(command.prompt, command.options));
    } catch (error) {
      // A rejected ACP request usually means the child process or transport is
      // no longer usable. Recreate it on the next command and resume the
      // persisted session instead of leaving subsequent requests pending.
      this.destroyClient();
      command.resolve({ success: false, error: this.friendlyError(error) });
    } finally {
      this.activeCallbacks = {};
      this.activeToolCalls.clear();
      this.clearAbortTimer();
      this.isProcessing = false;
      void this.processQueue();
    }
  }

  private async executeQueued(prompt: string, options: ExecuteOptions): Promise<ExecuteResult> {
    const blocks: AcpContentBlock[] = [];
    if (prompt) blocks.push({ type: 'text', text: prompt });
    for (const attachment of options.attachments ?? []) {
      if (attachment.type === 'image') {
        blocks.push({ type: 'image', data: attachment.data, mimeType: attachment.mimeType });
      }
    }
    if (blocks.length === 0) return { success: false, error: 'Empty prompt' };

    let output = '';
    this.activeCallbacks = {
      onStream: (chunk) => {
        output += chunk;
        options.onStream?.(chunk);
      },
      onToolUse: options.onToolUse,
      onToolResult: options.onToolResult,
      onPlanMode: options.onPlanMode,
      onImage: options.onImage,
    };

    const { client, sessionId } = await this.ensureSession();
    const result = await client.prompt(sessionId, blocks);
    const success = !['refusal', 'cancelled', 'error'].includes(result.stopReason);
    return {
      success,
      output,
      error: success ? undefined : `${this.backendLabel} stopped with reason: ${result.stopReason}`,
      sessionAbbr: sessionId.slice(0, 8),
    };
  }

  private async ensureSession(): Promise<{ client: AcpTransport; sessionId: string }> {
    if (this.client && this.sessionId) return { client: this.client, sessionId: this.sessionId };
    const client = this.createClient();
    try {
      await client.initialize();
      let result;
      if (this.sessionId) {
        try {
          result = await client.loadSession(this.sessionId, this.currentWorkingDirectory);
        } catch (error) {
          console.warn(`[${this.backendLabel}Executor] Stored session could not be loaded; starting fresh`, error);
          this.clearSessionPointer();
        }
      }
      if (!this.sessionId) {
        result = await client.newSession(this.currentWorkingDirectory);
        if (!result.sessionId) throw new Error(`${this.backendLabel} did not return a session ID`);
        this.sessionId = result.sessionId;
        this.saveSessionPointer();
      }
      this.updateConfigOptions(result);
      this.client = client;
      await this.applyConfiguredOptions(client, this.sessionId!);
      return { client, sessionId: this.sessionId! };
    } catch (error) {
      client.destroy();
      throw error;
    }
  }

  private createClient(): AcpTransport {
    const callbacks: AcpEventCallbacks = {
      onTextChunk: (content) => this.handleContent(content, false),
      onThoughtChunk: (content) => this.handleContent(content, true),
      onToolCall: (tool) => {
        const previous = this.activeToolCalls.get(tool.toolCallId);
        const merged = { ...previous, ...tool };
        this.activeToolCalls.set(tool.toolCallId, merged);
        const mapped = mapAcpToolCall(merged);
        this.activeCallbacks.onToolUse?.({ id: tool.toolCallId, ...mapped });
      },
      onToolResult: (tool) => {
        const merged = { ...this.activeToolCalls.get(tool.toolCallId), ...tool };
        this.activeToolCalls.delete(tool.toolCallId);
        this.activeCallbacks.onToolResult?.({
          tool_use_id: tool.toolCallId,
          ...acpToolResult(merged),
          is_error: tool.status === 'failed',
        });
      },
      onPlan: (entries) => this.activeCallbacks.onPlanMode?.(
        entries.map((entry) => `[${entry.status ?? 'pending'}] ${entry.content}`).join('\n')
      ),
      onConfigOptions: (options) => { this.configOptions = options; },
      onPermissionRequest: async (title, options) => {
        const isQuestion = options.some((option) => /^q\d+_opt_\d+$/.test(option.optionId));
        if (this.autoApprove && !isQuestion) {
          const allowed = options.findIndex((option) => option.kind === 'allow_once');
          return allowed >= 0 ? allowed : 0;
        }
        this.cancelPendingPermission();
        const prompt = isQuestion
          ? [`\n${title}`, ...options.filter((option) => option.kind.startsWith('allow')).map((option, index) => `${index + 1}. ${option.name ?? option.optionId}`), 'Reply with an option number, option name, skip, or cancel.\n'].join('\n')
          : `\nApproval required for ${title}. Reply yes, always, no, or cancel.\n`;
        this.activeCallbacks.onStream?.(prompt);
        return new Promise<number>((resolve) => {
          this.pendingPermission = { title, options, isQuestion, resolve };
        });
      },
    };
    return this.clientFactory(callbacks, this.currentWorkingDirectory);
  }

  private handleContent(content: AcpContentBlock, thinking: boolean): void {
    if (content.type === 'text' && typeof content.text === 'string') {
      this.activeCallbacks.onStream?.(content.text);
    } else if (!thinking && content.type === 'image' && typeof content.data === 'string' && typeof content.mimeType === 'string') {
      this.activeCallbacks.onImage?.({ type: 'image', data: content.data, mimeType: content.mimeType });
    }
  }

  private async applyConfiguredOptions(client: AcpTransport, sessionId: string): Promise<void> {
    if (this.model) this.updateConfigOptions(await client.setConfigOption(sessionId, 'model', this.model));
    if (this.effort) this.updateConfigOptions(await client.setConfigOption(sessionId, this.effortConfigId, this.effort));
  }

  private updateConfigOptions(result?: AcpSessionResult): void {
    if (result?.configOptions) this.configOptions = result.configOptions;
  }

  private findConfigOption(id: string): AcpConfigOption | undefined {
    return this.configOptions.find((option) => option.id === id);
  }

  private loadSessionPointer(): void {
    try {
      const value = JSON.parse(fs.readFileSync(this.sessionFilePath, 'utf8')) as { id?: string; cwd?: string };
      if (value.id && (!value.cwd || value.cwd === this.currentWorkingDirectory)) this.sessionId = value.id;
    } catch {}
  }

  private saveSessionPointer(): void {
    fs.writeFileSync(this.sessionFilePath, JSON.stringify({ id: this.sessionId, cwd: this.currentWorkingDirectory }), 'utf8');
  }

  private clearSessionPointer(): void {
    this.sessionId = null;
    this.configOptions = [];
    try {
      fs.unlinkSync(this.sessionFilePath);
    } catch {}
  }

  private destroyClient(): void {
    this.clearAbortTimer();
    this.cancelPendingPermission();
    this.client?.destroy();
    this.client = null;
  }

  private clearAbortTimer(): void {
    if (this.abortTimer) clearTimeout(this.abortTimer);
    this.abortTimer = null;
  }

  private cancelPendingPermission(): void {
    const pending = this.pendingPermission;
    this.pendingPermission = null;
    pending?.resolve(-1);
  }

  private friendlyError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    if (/ENOENT|not found/i.test(message)) {
      return `${this.backendLabel} CLI is not installed or not found on PATH. Install it with \`${this.installCommand}\`, or use /backend to switch backends.`;
    }
    if (/provider\.auth|authentication required|no provider configured|not available in your country/i.test(message)) {
      return `${this.backendLabel} authentication failed: ${message}. Use /model to choose an available model or run \`${this.authCommand}\`.`;
    }
    return message;
  }
}
