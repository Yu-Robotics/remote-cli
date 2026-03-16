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

/**
 * IExecutor implementation for Gemini CLI via ACP (Agent Client Protocol).
 *
 * Each execute() call spawns a fresh Gemini CLI subprocess (vibe-kanban style).
 * This ensures full isolation between turns — a broken session in one turn
 * cannot affect subsequent turns.
 *
 * Conversation history is persisted as JSONL via SessionManager and replayed
 * as context prefix on subsequent calls within the same conversation.
 *
 * When a quota error is returned by the configured model, the executor
 * automatically retries with QUOTA_FALLBACK_MODELS in order until one succeeds.
 */
export class GeminiExecutor implements IExecutor {
  /** Models tried in order when the configured model returns a quota error. */
  private static readonly QUOTA_FALLBACK_MODELS = ['gemini-2.5-flash', 'gemini-1.5-flash'];

  private static isQuotaError(error: unknown): boolean {
    return error instanceof Error && error.message.includes('exhausted your capacity');
  }
  private directoryGuard: DirectoryGuard;
  private currentWorkingDirectory: string;
  private sessionManager: SessionManager;

  private readonly model: string;
  private readonly autoApprove: boolean;
  private readonly geminiCommand: string;
  private readonly geminiVersion: string;

  /** Stable ID for JSONL history file, survives across spawns. */
  private conversationId: string | null = null;

  /** Reference to the in-flight AcpClient for abort support. */
  private inflightClient: AcpClient | null = null;

  constructor(directoryGuard: DirectoryGuard, options: GeminiExecutorOptions = {}) {
    this.directoryGuard = directoryGuard;
    // Default to 'auto' so Gemini CLI picks the best available model
    // rather than defaulting to the highest-quota-consuming pro model.
    this.model = options.model ?? 'auto';
    this.autoApprove = options.autoApprove ?? true;
    this.geminiCommand = options.geminiCommand ?? 'npx';
    this.geminiVersion = options.geminiVersion ?? '@google/gemini-cli@latest';
    this.currentWorkingDirectory = options.initialWorkingDirectory ?? process.cwd();
    this.sessionManager = new SessionManager();
  }

  // ─── IExecutor required ─────────────────────────────────────────────────────

  async execute(prompt: string, options: ExecuteOptions): Promise<ExecuteResult> {
    // Ensure a stable conversation ID exists for history tracking across spawns
    if (!this.conversationId) {
      this.conversationId = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }

    const acpCallbacks: AcpEventCallbacks = {
      onTextChunk: (text) => {
        options.onStream?.(text);
      },
      onToolCall: (toolCallId, title, kind) => {
        options.onToolUse?.({ id: toolCallId, name: title, input: { kind } });
      },
      onToolResult: (toolCallId, status, output) => {
        options.onToolResult?.({
          tool_use_id: toolCallId,
          content: output ?? '',
          is_error: status !== 'completed',
        });
      },
      onPlan: (text) => {
        options.onPlanMode?.(text);
      },
      onPermissionRequest: this.autoApprove ? undefined : async () => 0,
    };

    // Prepend history context for follow-up turns within the same conversation
    const historyContext = this.sessionManager.buildResumeContext(this.conversationId);
    const finalPrompt = historyContext ? `${historyContext}${prompt}` : prompt;

    this.sessionManager.append(this.conversationId, 'user', prompt);

    // Try the configured model first, then fallback models on quota exhaustion
    const modelsToTry = [
      this.model,
      ...GeminiExecutor.QUOTA_FALLBACK_MODELS.filter(m => m !== this.model),
    ];

    let lastError: unknown;
    for (const model of modelsToTry) {
      let accumulatedOutput = '';
      const callbacks: AcpEventCallbacks = {
        ...acpCallbacks,
        onTextChunk: (text) => {
          accumulatedOutput += text;
          options.onStream?.(text);
        },
      };

      const client = new AcpClient(
        this.geminiCommand,
        this.buildGeminiArgs(model),
        this.currentWorkingDirectory,
        callbacks
      );
      this.inflightClient = client;

      try {
        console.log(`[GeminiExecutor] Spawning new ACP client for cwd: ${this.currentWorkingDirectory}`);
        console.log(`[GeminiExecutor] Gemini command: ${this.geminiCommand} ${this.buildGeminiArgs(model).join(' ')}`);

        await client.initialize();
        const sessionId = await client.newSession(this.currentWorkingDirectory);
        console.log(`[GeminiExecutor] ACP session created: ${sessionId.slice(0, 8)}`);

        if (this.autoApprove) {
          console.log(`[GeminiExecutor] Switching session to YOLO mode...`);
          await client.setSessionMode(sessionId, 'yolo');
        }

        console.log(`[GeminiExecutor] Sending prompt (length=${finalPrompt.length})...`);
        const promptResult = await client.prompt(sessionId, finalPrompt);
        console.log(`[GeminiExecutor] Prompt completed, stopReason=${promptResult.stopReason}`);

        this.sessionManager.append(this.conversationId, 'assistant', accumulatedOutput);

        return {
          success: promptResult.stopReason !== 'refusal',
          output: accumulatedOutput,
          sessionAbbr: this.conversationId.slice(0, 8),
        };
      } catch (error) {
        lastError = error;
        if (GeminiExecutor.isQuotaError(error)) {
          const quotaMsg = error instanceof Error ? error.message : String(error);
          console.warn(`[GeminiExecutor] ⚠️ Quota exhausted for model "${model}": ${quotaMsg}`);
          if (model !== modelsToTry[modelsToTry.length - 1]) {
            const nextModel = modelsToTry[modelsToTry.indexOf(model) + 1];
            console.warn(`[GeminiExecutor] Retrying with fallback model: ${nextModel}`);
          }
          continue;
        }
        // Non-quota error — surface immediately, no retry
        console.error(`[GeminiExecutor] ❌ Execute error:`, error);
        const msg = error instanceof Error ? error.message : 'Unknown error';
        const friendlyMsg = msg.includes('ENOENT') || msg.includes('not found')
          ? 'Gemini CLI is not installed or not found on PATH. Use /backend to switch to another AI backend.'
          : msg;
        return { success: false, error: friendlyMsg };
      } finally {
        client.destroy();
        this.inflightClient = null;
      }
    }

    // All models exhausted
    const exhaustedMsg = lastError instanceof Error ? lastError.message : 'All models quota exhausted';
    console.error(`[GeminiExecutor] ❌ All fallback models quota exhausted`);
    return { success: false, error: exhaustedMsg };
  }

  getCurrentWorkingDirectory(): string {
    return this.currentWorkingDirectory;
  }

  async setWorkingDirectory(targetPath: string): Promise<void> {
    const resolved = this.directoryGuard.resolveWorkingDirectory(targetPath);
    this.currentWorkingDirectory = resolved;
    // Changing directory resets the conversation context
    this.conversationId = null;
  }

  resetContext(): void {
    if (this.conversationId) {
      this.sessionManager.remove(this.conversationId);
      this.conversationId = null;
    }
  }

  async abort(): Promise<boolean> {
    if (!this.inflightClient) return false;
    this.inflightClient.destroy();
    this.inflightClient = null;
    return true;
  }

  async destroy(): Promise<void> {
    if (this.inflightClient) {
      this.inflightClient.destroy();
      this.inflightClient = null;
    }
  }

  // ─── Internal helpers ───────────────────────────────────────────────────────

  private buildGeminiArgs(model: string = this.model): string[] {
    const args: string[] = ['-y', this.geminiVersion, '--experimental-acp'];
    if (model) {
      args.push('--model', model);
    }
    if (this.autoApprove) {
      args.push('--yolo');
    }
    return args;
  }
}
