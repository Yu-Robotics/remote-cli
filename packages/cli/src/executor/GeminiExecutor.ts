import { DirectoryGuard } from '../security/DirectoryGuard';
import { IExecutor, ExecuteOptions, ExecuteResult } from './IExecutor';
import { AcpClient, AcpEventCallbacks } from './acp/AcpClient';
import { SessionManager } from './acp/SessionManager';

export interface GeminiExecutorOptions {
  model?: string;
  /** Auto-approve all tool permission requests. Default: true. */
  autoApprove?: boolean;
  initialWorkingDirectory?: string;
  /** CLI command to run Gemini. Default: 'npx' */
  geminiCommand?: string;
  /** Gemini CLI npm package version specifier. Default: '@google/gemini-cli@latest' */
  geminiVersion?: string;
}

interface ActiveSession {
  client: AcpClient;
  sessionId: string;
}

/**
 * IExecutor implementation for Gemini CLI via ACP (Agent Client Protocol).
 *
 * One ACP child process is maintained per working directory.
 * On setWorkingDirectory, the existing process is terminated and a fresh
 * session is created on the next execute() call.
 *
 * Session history is persisted as JSONL and replayed as context when creating
 * new ACP sessions (since ACP session/resume is experimental).
 *
 * Callbacks are held as mutable references so the same AcpClient instance can
 * serve multiple sequential execute() calls without being recreated.
 */
export class GeminiExecutor implements IExecutor {
  private directoryGuard: DirectoryGuard;
  private currentWorkingDirectory: string;
  private sessionManager: SessionManager;
  private active: ActiveSession | null = null;
  private isExecuting = false;

  private readonly model: string;
  private readonly autoApprove: boolean;
  private readonly geminiCommand: string;
  private readonly geminiVersion: string;

  // Mutable callback slots — updated before each execute() call
  private currentOnStream: ((chunk: string) => void) | undefined;
  private currentOnToolUse: ((toolUse: { id: string; name: string; input: Record<string, unknown> }) => void) | undefined;
  private currentOnToolResult: ((result: { tool_use_id: string; content: string; is_error: boolean }) => void) | undefined;
  private currentOnPlanMode: ((planContent: string) => void) | undefined;
  private currentAccumulate: (text: string) => void = () => {};

  constructor(directoryGuard: DirectoryGuard, options: GeminiExecutorOptions = {}) {
    this.directoryGuard = directoryGuard;
    this.model = options.model ?? '';
    this.autoApprove = options.autoApprove ?? true;
    this.geminiCommand = options.geminiCommand ?? 'npx';
    this.geminiVersion = options.geminiVersion ?? '@google/gemini-cli@latest';
    this.currentWorkingDirectory = options.initialWorkingDirectory ?? process.cwd();
    this.sessionManager = new SessionManager();
  }

  // ─── IExecutor required ─────────────────────────────────────────────────────

  async execute(prompt: string, options: ExecuteOptions): Promise<ExecuteResult> {
    // Update mutable callback slots before the call
    let accumulatedOutput = '';
    this.currentAccumulate = (text: string) => { accumulatedOutput += text; };
    this.currentOnStream = options.onStream;
    this.currentOnToolUse = options.onToolUse;
    this.currentOnToolResult = options.onToolResult;
    this.currentOnPlanMode = options.onPlanMode;

    const { client, sessionId } = await this.ensureClient();

    // Prepend history context for session continuity
    const historyContext = this.sessionManager.buildResumeContext(sessionId);
    const finalPrompt = historyContext ? `${historyContext}${prompt}` : prompt;

    this.sessionManager.append(sessionId, 'user', prompt);
    this.isExecuting = true;

    try {
      const promptResult = await client.prompt(sessionId, finalPrompt);

      this.sessionManager.append(sessionId, 'assistant', accumulatedOutput);

      return {
        success: promptResult.stopReason !== 'refusal',
        output: accumulatedOutput,
        sessionAbbr: sessionId.slice(0, 8),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    } finally {
      this.isExecuting = false;
    }
  }

  getCurrentWorkingDirectory(): string {
    return this.currentWorkingDirectory;
  }

  async setWorkingDirectory(targetPath: string): Promise<void> {
    const resolved = this.directoryGuard.resolveWorkingDirectory(targetPath);

    // Tear down current ACP process — new session will start in new directory
    if (this.active) {
      try {
        this.active.client.sendCancel(this.active.sessionId);
      } catch {
        // best-effort cancel
      }
      this.active.client.destroy();
      this.active = null;
    }

    this.currentWorkingDirectory = resolved;
  }

  resetContext(): void {
    if (this.active) {
      this.sessionManager.remove(this.active.sessionId);
      this.active = null;
    }
    // Note: does NOT destroy the child process — a new ACP session is cheaper than a new process.
    // However since we null active, ensureClient() will create a fresh session (and process,
    // because the old one has no reference anymore).
  }

  async abort(): Promise<boolean> {
    if (!this.active) return false;
    try {
      this.active.client.sendCancel(this.active.sessionId);
    } catch {
      // ignore
    }
    this.active.client.destroy();
    this.active = null;
    this.isExecuting = false;
    return true;
  }

  async destroy(): Promise<void> {
    if (this.active) {
      this.active.client.destroy();
      this.active = null;
    }
  }

  // ─── Internal helpers ───────────────────────────────────────────────────────

  private async ensureClient(): Promise<ActiveSession> {
    if (this.active) return this.active;

    // Build ACP callbacks that forward to the mutable slots
    // Using arrow functions that close over `this` so they always call the
    // currently-set callbacks for the in-flight execute() call.
    const acpCallbacks: AcpEventCallbacks = {
      onTextChunk: (text) => {
        this.currentAccumulate(text);
        this.currentOnStream?.(text);
      },
      onToolCall: (toolCallId, title, kind) => {
        this.currentOnToolUse?.({ id: toolCallId, name: title, input: { kind } });
      },
      onToolResult: (toolCallId, status, output) => {
        this.currentOnToolResult?.({
          tool_use_id: toolCallId,
          content: output ?? '',
          is_error: status !== 'completed',
        });
      },
      onPlan: (text) => {
        this.currentOnPlanMode?.(text);
      },
      onPermissionRequest: this.autoApprove ? undefined : async () => 0,
    };

    const client = new AcpClient(
      this.geminiCommand,
      this.buildGeminiArgs(),
      this.currentWorkingDirectory,
      acpCallbacks
    );

    await client.initialize();
    const sessionId = await client.newSession(this.currentWorkingDirectory);

    this.active = { client, sessionId };
    return this.active;
  }

  private buildGeminiArgs(): string[] {
    const args: string[] = ['-y', this.geminiVersion, '--experimental-acp'];
    if (this.model) {
      args.push('--model', this.model);
    }
    return args;
  }
}
