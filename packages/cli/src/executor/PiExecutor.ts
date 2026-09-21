import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DirectoryGuard } from '../security/DirectoryGuard';
import type { Attachment } from '../types';
import type { ExecuteOptions, ExecuteResult, ExecutorModelInfo, IExecutor } from './IExecutor';
import { PiClient } from './pi/PiClient';
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
  sessionBaseDir?: string;
  clientFactory?: (launch: PiLaunchOptions) => PiTransport;
}

interface ActiveTurn {
  options: ExecuteOptions;
  resolve: (result: ExecuteResult) => void;
  output: string[];
  error?: string;
  lastRetryError?: string;
  sawAgentStart: boolean;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  settle?: () => void;
}

interface PendingUiRequest {
  id: string;
  method: string;
  title?: string;
  options?: string[];
}

interface SessionPointer {
  id?: string;
  sessionFile?: string;
  cwd?: string;
}

const DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1000;
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

function defaultPiThinkingLevel(levels: unknown): string {
  const available = Array.isArray(levels) ? levels.map((level) => String(level)) : [];
  if (available.includes('medium')) return 'medium';
  const preferred = available.find((level) => level !== 'off' && isPiThinkingLevel(level));
  if (preferred) return preferred;
  if (available[0] && isPiThinkingLevel(available[0])) return available[0];
  return 'medium';
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

/**
 * Persistent Pi executor backed by `pi --mode rpc`.
 * One instance is owned by one remote-cli thread.
 */
export class PiExecutor implements IExecutor {
  private readonly directoryGuard: DirectoryGuard;
  private currentWorkingDirectory: string;
  private model?: string;
  private effort?: string;
  private readonly provider?: string;
  private readonly autoApprove: boolean;
  private readonly threadId?: string;
  private readonly sessionFilePath: string;
  private readonly sessionStoreDir: string;
  private readonly piCommand?: string;
  private readonly createClient: (launch: PiLaunchOptions) => PiTransport;

  private client: PiTransport;
  private unsubscribe: (() => void) | null = null;
  private sessionId: string | null = null;
  private sessionFile: string | null = null;
  private activeTurn: ActiveTurn | null = null;
  private pendingUi: PendingUiRequest | null = null;
  private destroyed = false;

  constructor(directoryGuard: DirectoryGuard, options: PiExecutorOptions = {}) {
    this.directoryGuard = directoryGuard;
    this.model = options.model;
    this.effort = options.effort && options.effort !== 'auto' ? options.effort : undefined;
    this.provider = options.provider;
    this.autoApprove = options.autoApprove ?? true;
    this.threadId = options.threadId;
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
    if (this.activeTurn) {
      return { success: false, error: 'Pi thread is already running a command' };
    }

    const trimmed = prompt.trim();
    if (trimmed === '/skills' || trimmed === '/skill') {
      return this.listSkills();
    }
    if (trimmed.startsWith('/')) {
      const validationError = await this.validateSlashCommand(trimmed);
      if (validationError) return { success: false, error: validationError };
    }

    try {
      await this.ensureClient();
    } catch (error) {
      return { success: false, error: this.friendlyError(error) };
    }

    return new Promise<ExecuteResult>((resolve) => {
      const active: ActiveTurn = {
        options,
        resolve,
        output: [],
        sawAgentStart: false,
      };
      if (options.timeout && options.timeout > 0) {
        active.timeoutTimer = setTimeout(() => {
          void this.failActive(`Command timed out after ${options.timeout}ms`);
        }, options.timeout);
      } else {
        active.timeoutTimer = setTimeout(() => {
          void this.failActive(`Command timed out after ${DEFAULT_TURN_TIMEOUT_MS}ms`);
        }, DEFAULT_TURN_TIMEOUT_MS);
      }
      this.activeTurn = active;

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

  async setWorkingDirectory(targetPath: string): Promise<void> {
    const resolved = this.directoryGuard.resolveWorkingDirectory(
      targetPath,
      this.currentWorkingDirectory
    );
    if (resolved === this.currentWorkingDirectory) return;

    this.currentWorkingDirectory = resolved;
    // A Pi session owns the cwd recorded in its session header. Reopening the
    // previous session file would silently keep tools in the old directory.
    this.clearPointer();
    this.client.updateLaunch?.(this.buildLaunch());
    await this.recycleClient();
  }

  resetContext(): void {
    if (this.destroyed) return;
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
    if (!this.client.isRunning()) return false;
    try {
      await this.client.request({ type: 'clear_queue' });
    } catch {
      // Queue may already be empty.
    }
    try {
      await this.client.request({ type: 'abort' });
    } catch {
      await this.recycleClient();
    }
    if (this.activeTurn) {
      this.completeActive({ success: false, error: 'Aborted', sessionAbbr: this.sessionAbbr() });
    }
    this.cancelPendingUi(true);
    return true;
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.cancelPendingUi(true);
    if (this.activeTurn) {
      this.completeActive({ success: false, error: 'Executor destroyed' });
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.client.stop();
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
      this.client.send({ type: 'extension_ui_response', id: pending.id, value: options[index - 1] });
      return true;
    }
    const match = options.find((option) => option.toLowerCase() === trimmed.toLowerCase());
    this.client.send({ type: 'extension_ui_response', id: pending.id, value: match ?? trimmed });
    return true;
  }

  async compact(onStream?: (chunk: string) => void): Promise<ExecuteResult> {
    return this.compactWhenFull(onStream);
  }

  async compactWhenFull(onStream?: (chunk: string) => void): Promise<ExecuteResult> {
    if (this.activeTurn) {
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
      this.client.updateLaunch?.({ model: this.model, provider: resolved.provider });
      return { success: true, output: `Model set to ${this.model}.` };
    } catch (error) {
      return { success: false, error: this.friendlyError(error) };
    }
  }

  async clearModel(): Promise<void> {
    this.model = undefined;
    this.client.updateLaunch?.({ model: undefined, provider: this.provider });
    if (!this.client.isRunning()) return;
    try {
      const models = await this.listModels();
      const fallback = models.find((model) => model.isDefault) ?? models[0];
      if (!fallback) {
        await this.recycleClient();
        return;
      }
      const parsed = parsePiModelRef(fallback.id);
      const response = await this.client.request({
        type: 'set_model',
        provider: parsed.provider,
        modelId: parsed.modelId,
      });
      if (!response.success) {
        await this.recycleClient();
      }
    } catch {
      await this.recycleClient();
    }
  }

  async listModels(): Promise<ExecutorModelInfo[]> {
    await this.ensureClient();
    const response = await this.client.request({ type: 'get_available_models' });
    if (!response.success) {
      throw new Error(response.error || 'Failed to list Pi models');
    }
    const models = Array.isArray(response.data?.models) ? response.data.models as PiModel[] : [];
    return models.map((model, index) => ({
      id: formatPiModelRef(model),
      displayName: model.name || model.id,
      isDefault: index === 0,
      supportedReasoningEfforts: model.reasoning ? [...PI_THINKING_LEVELS] : ['off'],
      inputModalities: model.input,
    }));
  }

  async setEffort(effort: string): Promise<ExecuteResult> {
    const trimmed = effort.trim().toLowerCase();
    if (trimmed === 'auto') {
      this.effort = undefined;
      this.client.updateLaunch?.({ thinking: undefined });
      if (this.client.isRunning()) {
        try {
          const available = await this.client.request({ type: 'get_available_thinking_levels' });
          const level = defaultPiThinkingLevel(available.data?.levels);
          const response = await this.client.request({ type: 'set_thinking_level', level });
          if (!response.success) {
            return { success: false, error: response.error || 'Failed to restore Pi thinking level' };
          }
        } catch (error) {
          return { success: false, error: this.friendlyError(error) };
        }
      }
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
      const response = await this.client.request({ type: 'set_thinking_level', level: trimmed });
      if (!response.success) {
        return { success: false, error: response.error || `Failed to set thinking level: ${trimmed}` };
      }
      this.effort = trimmed;
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

  async deleteThreadData(threadId: string): Promise<void> {
    const pointerPath = path.join(path.dirname(this.sessionFilePath), `${threadId}.json`);
    let sessionFile = this.sessionFile;
    try {
      const stored = JSON.parse(fs.readFileSync(pointerPath, 'utf8')) as SessionPointer;
      sessionFile = stored.sessionFile ?? sessionFile;
    } catch {
      // Pointer may already be gone.
    }
    try { fs.unlinkSync(pointerPath); } catch { /* ignore */ }
    if (sessionFile) {
      try { fs.unlinkSync(sessionFile); } catch { /* ignore */ }
    }
    if (threadId === this.threadId) {
      this.sessionId = null;
      this.sessionFile = null;
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
    if (!this.client.isRunning()) {
      this.client.updateLaunch?.(this.buildLaunch());
      await this.client.start();
      await this.refreshSessionPointer();
    }
  }

  private async recycleClient(): Promise<void> {
    await this.client.stop();
  }

  private replaceClient(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    const previous = this.client;
    this.client = this.createClient(this.buildLaunch());
    this.unsubscribe = this.client.onEvent((event) => this.handleEvent(event));
    void previous.stop().catch((error) => {
      console.warn('[PiExecutor] Failed to stop previous Pi RPC process', error);
    });
  }

  private forgetSession(): void {
    const sessionFile = this.sessionFile;
    this.clearPointer();
    if (sessionFile) {
      try { fs.unlinkSync(sessionFile); } catch { /* ignore */ }
    }
  }

  private buildLaunch(): PiLaunchOptions {
    const pointerFile = this.sessionFile && fs.existsSync(this.sessionFile) ? this.sessionFile : undefined;
    return {
      command: this.piCommand,
      cwd: this.currentWorkingDirectory,
      approveProject: this.autoApprove,
      sessionDir: this.sessionStoreDir,
      sessionId: this.sessionId ?? this.threadId,
      sessionFile: pointerFile,
      sessionName: this.threadId ? `remote-cli-${this.threadId}` : undefined,
      provider: this.provider,
      model: this.model,
      thinking: this.effort,
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
      }
      return;
    }

    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      const text = extractMessageText(event.message);
      if (text && active.output.join('') === '') {
        active.output.push(text);
        active.options.onStream?.(text);
      }
      return;
    }

    if (event.type === 'turn_end') {
      const text = extractMessageText(event.message);
      if (text && active.output.join('') === '') {
        active.output.push(text);
        active.options.onStream?.(text);
      }
      return;
    }

    if (event.type === 'tool_execution_start') {
      const mapped = mapPiTool(String(event.toolName ?? 'tool'), event.args);
      active.options.onToolUse?.({
        id: String(event.toolCallId ?? mapped.name),
        name: mapped.name,
        input: mapped.input,
      });
      return;
    }

    if (event.type === 'tool_execution_end') {
      active.options.onToolResult?.({
        tool_use_id: String(event.toolCallId ?? ''),
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

    if (event.type === 'auto_retry_start' && event.errorMessage) {
      active.lastRetryError = String(event.errorMessage);
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
      if (method === 'notify' && event.message) {
        this.activeTurn?.options.onStream?.(`\n${event.message}\n`);
      }
      return;
    }

    const options = Array.isArray(event.options) ? event.options.map((option: unknown) => String(option)) : [];
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
      lines = [`\n${title}`, ...options.map((option, index) => `${index + 1}. ${option}`), 'Reply with an option number, option name, skip, or cancel.\n'];
    } else {
      lines = [`\n${title}`, 'Reply with a value, or send skip or cancel.\n'];
    }
    this.activeTurn?.options.onStream?.(lines.join('\n'));
    this.pendingUi = { id, method, title, options };
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
      if (stored.id) this.sessionId = stored.id;
      if (stored.sessionFile) this.sessionFile = stored.sessionFile;
    } catch {
      // First run for this thread.
    }
  }

  private savePointer(): void {
    const pointer: SessionPointer = {
      id: this.sessionId ?? undefined,
      sessionFile: this.sessionFile ?? undefined,
      cwd: this.currentWorkingDirectory,
    };
    const temporaryPath = `${this.sessionFilePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify(pointer), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporaryPath, this.sessionFilePath);
    } catch (error) {
      try { fs.unlinkSync(temporaryPath); } catch { /* ignore */ }
      console.warn('[PiExecutor] Failed to save Pi session pointer', error);
    }
  }

  private clearPointer(): void {
    this.sessionId = null;
    this.sessionFile = null;
    try { fs.unlinkSync(this.sessionFilePath); } catch { /* ignore */ }
  }

  private completeActive(result: ExecuteResult): void {
    const active = this.activeTurn;
    if (!active) return;
    this.activeTurn = null;
    if (active.timeoutTimer) clearTimeout(active.timeoutTimer);
    active.settle?.();
    this.cancelPendingUi(true);
    active.resolve(result);
  }

  private async failActive(error: string): Promise<void> {
    if (!this.activeTurn) return;
    try {
      await this.client.request({ type: 'abort' });
    } catch {
      await this.recycleClient();
    }
    this.completeActive({ success: false, error, sessionAbbr: this.sessionAbbr() });
  }

  private cancelPendingUi(cancel = false): void {
    const pending = this.pendingUi;
    this.pendingUi = null;
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
    if (/ENOENT|not found on PATH|not installed/i.test(message)) {
      return `Pi CLI is not installed or not found on PATH. Install it with \`${INSTALL_COMMAND}\`, authenticate with \`pi\`, or use /backend to switch backends.`;
    }
    return message;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type { PiRpcResponse };
