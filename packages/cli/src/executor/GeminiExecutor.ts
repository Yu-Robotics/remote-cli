import { DirectoryGuard } from '../security/DirectoryGuard';
import { IExecutor, ExecuteOptions, ExecuteResult } from './IExecutor';
import { AcpClient, AcpEventCallbacks } from './acp/AcpClient';
import { SessionManager } from './acp/SessionManager';

/** Number of most-recent conversation turns to keep after compaction. */
const COMPACT_KEEP_TURNS = 10;

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
 * Maps a Gemini ACP tool call (kind + title) to a Claude-compatible
 * { name, input } shape so the router's ToolFormatter renders it with
 * the same collapsible card style as Claude tools.
 *
 * Gemini ACP kinds: 'exec' | 'read' | 'write' | 'list' | 'service' | ...
 */
function mapAcpToolCall(
  kind: string | undefined,
  title: string,
): { name: string; input: Record<string, string> } {
  switch (kind) {
    case 'exec':
      // Shell command — map to Bash so extractBashContext renders it
      return { name: 'Bash', input: { command: title } };
    case 'read':
      // File read — map to Read so extractReadContext renders it
      return { name: 'Read', input: { file_path: title } };
    case 'write':
      // File write/edit — map to Write
      return { name: 'Write', input: { file_path: title } };
    case 'list':
      // Directory listing — map to Glob
      return { name: 'Glob', input: { pattern: title } };
    case 'service':
      // MCP / service call
      return { name: 'Service', input: { call: title } };
    default:
      // Unknown kind — show raw title under generic tool name
      return { name: kind ?? 'Tool', input: { command: title } };
  }
}

/**
 * Gemini CLI stable model aliases used for quota fallback.
 *
 * These are Gemini CLI's own named aliases (not versioned model strings), so
 * they remain valid across model releases. Gemini CLI's ACP mode does NOT
 * implement automatic model fallback on quota exhaustion (unlike interactive
 * mode), so we handle it here instead.
 *
 * Fallback order: user-configured model → flash → flash-lite
 */
const QUOTA_FALLBACK_ALIASES = ['flash', 'flash-lite'];

/** Returns true when the error message indicates a quota-exhaustion condition. */
function isQuotaError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes('exhausted your capacity') || error.message.includes('quota');
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
 */
export class GeminiExecutor implements IExecutor {
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
    // Leave model unset by default so Gemini CLI uses its own default
    // (gemini-2.5-pro). NOTE: '--model auto' maps to gemini-3-pro-preview
    // which has stricter quota limits — do NOT default to 'auto'.
    // Users can override via executor.gemini.model in config.
    this.model = options.model ?? '';
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

    // Prepend history context for follow-up turns within the same conversation
    const historyContext = this.sessionManager.buildResumeContext(this.conversationId);
    const finalPrompt = historyContext ? `${historyContext}${prompt}` : prompt;
    this.sessionManager.append(this.conversationId, 'user', prompt);

    // Build fallback chain: configured model first, then quota fallback aliases.
    // Filter out aliases that are already the configured model to avoid retrying
    // the same model twice.
    const fallbackAliases = QUOTA_FALLBACK_ALIASES.filter(a => a !== this.model);
    const modelsToTry = [this.model, ...fallbackAliases];

    for (let attempt = 0; attempt < modelsToTry.length; attempt++) {
      const modelForAttempt = modelsToTry[attempt];
      const modelLabel = modelForAttempt || 'pro (default)';

      if (attempt > 0) {
        const notice = `⚠️ Quota exhausted on **${modelsToTry[attempt - 1] || 'pro'}**, switching to **${modelLabel}**...\n\n`;
        options.onStream?.(notice);
        console.warn(`[GeminiExecutor] Quota exhausted on "${modelsToTry[attempt - 1] || 'pro'}", retrying with "${modelLabel}"`);
      }

      try {
        const result = await this.executeWithModel(modelForAttempt, modelLabel, finalPrompt, prompt, options);
        return result;
      } catch (error) {
        if (isQuotaError(error) && attempt < modelsToTry.length - 1) {
          // Quota exhausted on this model — try the next one in the chain
          continue;
        }
        // Final attempt or non-quota error: surface a friendly message
        console.error(`[GeminiExecutor] ❌ Execute error:`, error);
        const msg = error instanceof Error ? error.message : 'Unknown error';
        return { success: false, error: this.buildFriendlyError(msg, modelLabel) };
      }
    }

    // Should never reach here, but satisfy TypeScript
    return { success: false, error: 'All Gemini models exhausted quota.' };
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

  /**
   * Compact conversation history by truncating to the most recent turns.
   * Gemini ACP has no built-in /compact command, so we reduce context size
   * by keeping only the last COMPACT_KEEP_TURNS entries from the JSONL history.
   */
  async compactWhenFull(onStream?: (chunk: string) => void): Promise<ExecuteResult> {
    if (!this.conversationId) {
      return { success: true, output: 'No active conversation to compact.' };
    }

    onStream?.(`Truncating history to last ${COMPACT_KEEP_TURNS} turns...\n`);
    const removed = this.sessionManager.truncate(this.conversationId, COMPACT_KEEP_TURNS);

    if (removed === 0) {
      return { success: true, output: 'Conversation history is already compact.' };
    }

    onStream?.(`Removed ${removed} older entries from conversation history.\n`);
    return { success: true, output: `Compacted: removed ${removed} older entries, kept ${COMPACT_KEEP_TURNS} most recent turns.` };
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

  /**
   * Delete the Gemini session history file for a thread.
   * Called by ThreadExecutorPool before removing this executor from the pool.
   */
  async deleteThreadData(threadId: string): Promise<void> {
    if (this.conversationId) {
      this.sessionManager.remove(this.conversationId);
    }
  }

  /**
   * Runs a single attempt with a specific model alias.
   * Throws on quota errors so the caller can retry with the next model.
   */
  private async executeWithModel(
    model: string,
    modelLabel: string,
    finalPrompt: string,
    originalPrompt: string,
    options: ExecuteOptions,
  ): Promise<ExecuteResult> {
    let accumulatedOutput = '';

    const acpCallbacks: AcpEventCallbacks = {
      onThoughtChunk: (text) => {
        // Stream Gemini's thinking to the user, same as Claude does for thinking blocks
        accumulatedOutput += text;
        options.onStream?.(text);
      },
      onTextChunk: (text) => {
        accumulatedOutput += text;
        options.onStream?.(text);
      },
      onToolCall: (toolCallId, title, kind) => {
        // Map Gemini ACP kind → Claude-compatible tool name + structured input
        // so the router's ToolFormatter renders it consistently with Claude tools.
        // The tool card itself provides the progress indicator — no extra onStream needed.
        const { name, input } = mapAcpToolCall(kind, title);
        options.onToolUse?.({ id: toolCallId, name, input });
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

    const args = this.buildGeminiArgs(model);
    const client = new AcpClient(
      this.geminiCommand,
      args,
      this.currentWorkingDirectory,
      acpCallbacks
    );
    this.inflightClient = client;

    try {
      console.log(`[GeminiExecutor] Spawning ACP client (model=${modelLabel}) for cwd: ${this.currentWorkingDirectory}`);
      console.log(`[GeminiExecutor] Gemini command: ${this.geminiCommand} ${args.join(' ')}`);

      await client.initialize();
      const sessionId = await client.newSession(this.currentWorkingDirectory);
      console.log(`[GeminiExecutor] ACP session created: ${sessionId.slice(0, 8)}`);

      if (this.autoApprove) {
        await client.setSessionMode(sessionId, 'yolo');
      }

      console.log(`[GeminiExecutor] Sending prompt (length=${finalPrompt.length})...`);
      const promptResult = await client.prompt(sessionId, finalPrompt);
      console.log(`[GeminiExecutor] Prompt completed, stopReason=${promptResult.stopReason}, model=${modelLabel}`);

      this.sessionManager.append(this.conversationId!, 'assistant', accumulatedOutput);

      return {
        success: promptResult.stopReason !== 'refusal',
        output: accumulatedOutput,
        sessionAbbr: this.conversationId!.slice(0, 8),
      };
    } finally {
      client.destroy();
      this.inflightClient = null;
    }
  }

  private buildGeminiArgs(model?: string): string[] {
    const args: string[] = ['-y', this.geminiVersion, '--acp'];
    const resolvedModel = model ?? this.model;
    if (resolvedModel) {
      args.push('--model', resolvedModel);
    }
    if (this.autoApprove) {
      args.push('--yolo');
    }
    return args;
  }

  private buildFriendlyError(msg: string, modelLabel: string): string {
    if (msg.includes('ENOENT') || msg.includes('not found')) {
      return 'Gemini CLI is not installed or not found on PATH. Use /backend to switch to another AI backend.';
    }
    if (msg.includes('exhausted your capacity') || msg.includes('quota')) {
      const resetMatch = msg.match(/reset after ([^\s.]+)/i);
      const resetHint = resetMatch ? ` Quota resets in ${resetMatch[1]}.` : '';
      return (
        `⚠️ All Gemini models (${[this.model || 'pro', ...QUOTA_FALLBACK_ALIASES].join(' → ')}) have exhausted quota.${resetHint}\n\n` +
        `Wait for quota to reset, or switch backends:\n` +
        `\`/backend\``
      );
    }
    if (msg.includes('Premature close') || msg.includes('Gemini CLI exited')) {
      return `⚠️ Gemini's response stream was cut off before completing (server-side issue). The task may have partially executed — please verify your files before retrying.\n\nIf this keeps happening, try \`/backend\` to switch backends.`;
    }
    return msg;
  }
}
