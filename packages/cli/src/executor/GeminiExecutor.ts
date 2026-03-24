import { DirectoryGuard } from '../security/DirectoryGuard';
import { IExecutor, ExecuteOptions, ExecuteResult } from './IExecutor';
import { AcpClient, AcpEventCallbacks } from './acp/AcpClient';
import { ContentBlock } from './acp/AcpTypes';

/** Grace period (ms) between cooperative ACP cancel and force SIGTERM/SIGKILL. */
const CANCEL_GRACE_MS = 3_000;

export interface GeminiExecutorOptions {
  model?: string;
  /** Auto-approve all tool permission requests. Default: true. */
  autoApprove?: boolean;
  initialWorkingDirectory?: string;
  /** CLI command to run Gemini. Default: 'npx' */
  geminiCommand?: string;
  /** Gemini CLI npm package version specifier. Default: '@google/gemini-cli@latest' */
  geminiVersion?: string;
  /** Thread ID for session isolation */
  threadId?: string;
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
      return { name: 'Bash', input: { command: title } };
    case 'read':
      return { name: 'Read', input: { file_path: title } };
    case 'write':
      return { name: 'Write', input: { file_path: title } };
    case 'list':
      return { name: 'Glob', input: { pattern: title } };
    case 'service':
      return { name: 'Service', input: { call: title } };
    default:
      return { name: kind ?? 'Tool', input: { command: title } };
  }
}

/**
 * Gemini CLI stable model aliases used for quota fallback.
 *
 * Fallback order: user-configured model → flash → flash-lite
 */
const QUOTA_FALLBACK_ALIASES = ['flash', 'flash-lite'];

/** Returns true when the error message indicates a quota-exhaustion or capacity condition. */
function isQuotaError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message;

  // Check for specific ACP HTTP-like error codes (e.g. 429 Too Many Requests, 503 Service Unavailable)
  const acpErrorMatch = msg.match(/ACP error (\d+):/);
  if (acpErrorMatch) {
    const code = parseInt(acpErrorMatch[1], 10);
    if (code === 429 || code === 503) {
      return true;
    }
  }

  // Stricter string matching to avoid false positives like "quotation marks"
  const lowerMsg = msg.toLowerCase();
  return (
    lowerMsg.includes('exhausted your capacity') ||
    lowerMsg.includes('quota exceeded') ||
    lowerMsg.includes('quota exhausted') ||
    lowerMsg.includes('no capacity available')
  );
}

/**
 * IExecutor implementation for Gemini CLI via ACP (Agent Client Protocol).
 *
 * Uses a persistent ACP client — one long-lived Gemini CLI subprocess per
 * conversation. Each execute() call sends a new prompt to the same process,
 * which maintains its own KV cache. This is O(N) in token cost, matching
 * ClaudePersistentExecutor's approach exactly.
 *
 * The persistent client is destroyed (and respawned on next execute) when:
 *  - resetContext() is called
 *  - setWorkingDirectory() changes cwd (without threadId)
 *  - compactWhenFull() is called
 *  - abort() grace period elapses without a cancel response (last-resort kill)
 *  - a non-quota error occurs during execute()
 *  - a quota error triggers a model switch
 */
/**
 * Mutable options holder shared between the persistent AcpClient callbacks
 * and the per-execute call. Updated each time execute() starts so the
 * callbacks always reference the current call's options.
 */
interface ActiveOptions {
  onStream?: (chunk: string) => void;
  onToolUse?: (tool: { id: string; name: string; input: Record<string, unknown> }) => void;
  onToolResult?: (result: { tool_use_id: string; content: string; is_error: boolean }) => void;
  onPlanMode?: (text: string) => void;
}

export class GeminiExecutor implements IExecutor {
  private directoryGuard: DirectoryGuard;
  private currentWorkingDirectory: string;

  private readonly model: string;
  private readonly autoApprove: boolean;
  private readonly geminiCommand: string;
  private readonly geminiVersion: string;
  private readonly threadId?: string;

  /** Long-lived ACP client — null means not yet spawned or was destroyed. */
  private persistentClient: AcpClient | null = null;
  /** ACP session ID of the persistent session. */
  private persistentSessionId: string | null = null;

  /**
   * Mutable options for the current execute() call.
   * The persistent AcpClient callbacks close over this object so they always
   * dispatch to whichever execute() invocation is currently in flight.
   */
  private activeOptions: ActiveOptions = {};

  /** Reference to the in-flight AcpClient for abort support. */
  private inflightClient: AcpClient | null = null;
  /** ACP session ID of the in-flight prompt, needed for cooperative sendCancel. */
  private inflightSessionId: string | null = null;
  /** Handle for the abort grace-period timer so it can be cancelled early. */
  private abortTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Command queue for sequential execution.
   * Matching ClaudePersistentExecutor's approach to ensure thread-safety.
   */
  private commandQueue: Array<{
    prompt: string;
    options: ExecuteOptions;
    resolve: (result: ExecuteResult) => void;
    reject: (error: Error) => void;
  }> = [];
  private isProcessing = false;

  constructor(directoryGuard: DirectoryGuard, options: GeminiExecutorOptions = {}) {
    this.directoryGuard = directoryGuard;
    this.model = options.model ?? '';
    this.autoApprove = options.autoApprove ?? true;
    this.geminiCommand = options.geminiCommand ?? 'npx';
    this.geminiVersion = options.geminiVersion ?? '@google/gemini-cli@latest';
    this.currentWorkingDirectory = options.initialWorkingDirectory ?? process.cwd();
    this.threadId = options.threadId;
  }

  // ─── IExecutor required ─────────────────────────────────────────────────────

  async execute(prompt: string, options: ExecuteOptions): Promise<ExecuteResult> {
    return new Promise((resolve, reject) => {
      this.commandQueue.push({ prompt, options, resolve, reject });
      this.processQueue();
    });
  }

  /**
   * Processes the command queue sequentially.
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.commandQueue.length === 0) {
      return;
    }

    const command = this.commandQueue.shift();
    if (!command) return;

    this.isProcessing = true;
    try {
      const result = await this.executeQueued(command.prompt, command.options);
      command.resolve(result);
    } catch (error) {
      command.reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.isProcessing = false;
      this.processQueue();
    }
  }

  /**
   * Actual execution logic for a single prompt.
   */
  private async executeQueued(prompt: string, options: ExecuteOptions): Promise<ExecuteResult> {
    // Build fallback chain: configured model first, then quota fallback aliases.
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
        // Ensure a persistent session exists (spawn if needed)
        const { client, sessionId } = await this.ensurePersistentSession(modelForAttempt);
        const result = await this.executeWithClient(client, sessionId, modelLabel, prompt, options);
        return result;
      } catch (error) {
        if (isQuotaError(error) && attempt < modelsToTry.length - 1) {
          // Quota exhausted — destroy current client, next iteration spawns with fallback model
          this.destroyPersistentClient();
          continue;
        }
        // Final attempt or non-quota error: destroy client (so next call respawns) and surface error
        this.destroyPersistentClient();
        console.error(`[GeminiExecutor] ❌ Execute error:`, error);
        const msg = error instanceof Error ? error.message : 'Unknown error';
        return { success: false, error: this.buildFriendlyError(msg, modelLabel) };
      }
    }

    return { success: false, error: 'All Gemini models exhausted quota.' };
  }

  getCurrentWorkingDirectory(): string {
    return this.currentWorkingDirectory;
  }

  async setWorkingDirectory(targetPath: string): Promise<void> {
    const resolved = this.directoryGuard.resolveWorkingDirectory(targetPath);
    
    // If directory changes, we MUST restart the persistent process in the new directory.
    // This matches ClaudePersistentExecutor and ensures that tools (ls, read, etc.)
    // run in the expected location.
    const needsRestart = this.currentWorkingDirectory !== resolved && this.persistentClient !== null;
    
    this.currentWorkingDirectory = resolved;
    
    if (needsRestart) {
      console.log(`[GeminiExecutor] Restarting persistent client in new directory: ${resolved}`);
      this.destroyPersistentClient();
    }
  }

  resetContext(): void {
    this.destroyPersistentClient();
  }

  /**
   * Compact conversation history by resetting the persistent session.
   * Gemini ACP has no built-in /compact, so we destroy the client entirely.
   * The next execute() call will spawn a fresh process with no prior context.
   */
  async compactWhenFull(onStream?: (chunk: string) => void): Promise<ExecuteResult> {
    if (!this.persistentClient) {
      return { success: true, output: 'No active conversation to compact.' };
    }

    onStream?.('Resetting conversation context (Gemini has no /compact equivalent — starting fresh session)...\n');
    this.destroyPersistentClient();
    return {
      success: true,
      output: 'Context reset: conversation history cleared. Next message starts a fresh Gemini session.',
    };
  }

  async abort(): Promise<boolean> {
    if (!this.inflightClient) return false;

    // Clear any existing grace-period timer before starting a new one.
    // Without this, rapid double-abort would leak the first timer, which could
    // fire later and unexpectedly destroy the session.
    if (this.abortTimer !== null) {
      clearTimeout(this.abortTimer);
      this.abortTimer = null;
    }

    // Send cooperative ACP cancel so Gemini can finish the current tool call
    // cleanly before stopping (avoids half-written files).
    // NOTE: session/cancel only aborts the current prompt — it does NOT destroy
    // the session. The persistent client and session are preserved so the user
    // can continue the conversation after aborting.
    if (this.inflightSessionId) {
      this.inflightClient.sendCancel(this.inflightSessionId);
      console.log(`[GeminiExecutor] Sent ACP cancel for session ${this.inflightSessionId.slice(0, 8)}`);
    }

    // Give Gemini a grace period to respond with stopReason='cancelled'.
    // After the grace period, if Gemini hasn't responded yet, we force-destroy
    // the persistent client as a last resort (session recovery is not possible
    // once the subprocess is killed).
    const clientRef = this.inflightClient;
    this.abortTimer = setTimeout(() => {
      this.abortTimer = null;
      if (clientRef === this.inflightClient) {
        console.warn('[GeminiExecutor] Cancel grace period elapsed, force-destroying persistent client');
        this.destroyPersistentClient();
      }
    }, CANCEL_GRACE_MS);

    return true;
  }

  async destroy(): Promise<void> {
    if (this.inflightClient && this.inflightSessionId) {
      this.inflightClient.sendCancel(this.inflightSessionId);
    }
    // Always clear any pending abort timer, regardless of inflightClient state.
    if (this.abortTimer !== null) {
      clearTimeout(this.abortTimer);
      this.abortTimer = null;
    }
    this.destroyPersistentClient();
  }

  /**
   * Delete session data for a thread.
   * Called by ThreadExecutorPool before removing this executor from the pool.
   */
  async deleteThreadData(_threadId: string): Promise<void> {
    this.destroyPersistentClient();
  }

  getSessionId(): string | null {
    return this.persistentSessionId;
  }

  // ─── Internal helpers ────────────────────────────────────────────────────────

  /**
   * Returns the existing persistent session if alive, or spawns a new one.
   * The model parameter is only used when spawning a new session.
   */
  private async ensurePersistentSession(model: string): Promise<{ client: AcpClient; sessionId: string }> {
    if (this.persistentClient && this.persistentSessionId) {
      return { client: this.persistentClient, sessionId: this.persistentSessionId };
    }
    return this.spawnNewSession(model);
  }

  /**
   * Spawns a fresh Gemini CLI subprocess, initializes ACP, and creates a new session.
   * The AcpClient callbacks close over `this.activeOptions` so they always dispatch
   * to whichever execute() call is currently in flight.
   */
  private async spawnNewSession(model: string): Promise<{ client: AcpClient; sessionId: string }> {
    const args = this.buildGeminiArgs(model);

    const acpCallbacks: AcpEventCallbacks = {
      onThoughtChunk: (text) => {
        this.activeOptions.onStream?.(text);
      },
      onTextChunk: (text) => {
        this.activeOptions.onStream?.(text);
      },
      onToolCall: (toolCallId, title, kind) => {
        const { name, input } = mapAcpToolCall(kind, title);
        this.activeOptions.onToolUse?.({ id: toolCallId, name, input });
      },
      onToolResult: (toolCallId, status, output) => {
        this.activeOptions.onToolResult?.({
          tool_use_id: toolCallId,
          content: output ?? '',
          is_error: status !== 'completed',
        });
      },
      onPlan: (text) => {
        this.activeOptions.onPlanMode?.(text);
      },
      onPermissionRequest: this.autoApprove ? undefined : async () => 0,
    };

    const client = new AcpClient(
      this.geminiCommand,
      args,
      this.currentWorkingDirectory,
      acpCallbacks,
    );

    console.log(`[GeminiExecutor] Spawning persistent ACP client (model=${model || 'pro (default)'}) for cwd: ${this.currentWorkingDirectory}`);
    await client.initialize();
    const sessionId = await client.newSession(this.currentWorkingDirectory);
    console.log(`[GeminiExecutor] Persistent ACP session created: ${sessionId.slice(0, 8)}`);

    if (this.autoApprove) {
      try {
        await client.setSessionMode(sessionId, 'yolo');
      } catch (e) {
        console.warn(`[GeminiExecutor] Optional session mode 'yolo' not supported or rejected:`, e);
      }
    }

    this.persistentClient = client;
    this.persistentSessionId = sessionId;
    return { client, sessionId };
  }

  /**
   * Sends a single prompt to an existing persistent ACP session.
   * Sets activeOptions so the persistent callbacks dispatch to this call's handlers.
   */
  private async executeWithClient(
    client: AcpClient,
    sessionId: string,
    modelLabel: string,
    prompt: string,
    options: ExecuteOptions,
  ): Promise<ExecuteResult> {
    let accumulatedOutput = '';

    // Wire per-execute callbacks via activeOptions so the persistent AcpClient
    // callbacks (which close over this.activeOptions) dispatch to this call.
    this.activeOptions = {
      onStream: (chunk) => {
        accumulatedOutput += chunk;
        options.onStream?.(chunk);
      },
      onToolUse: options.onToolUse,
      onToolResult: options.onToolResult,
      onPlanMode: options.onPlanMode,
    };

    this.inflightClient = client;
    this.inflightSessionId = sessionId;

    try {
      // Build prompt blocks from text and attachments
      const promptBlocks: ContentBlock[] = [];
      if (prompt) {
        promptBlocks.push({ type: 'text', text: prompt });
      }
      if (options.attachments) {
        for (const attachment of options.attachments) {
          if (attachment.type === 'image') {
            promptBlocks.push({
              type: 'image',
              data: attachment.data,
              mimeType: attachment.mimeType,
            });
          }
        }
      }

      if (promptBlocks.length === 0) {
        return { success: false, error: 'Empty prompt' };
      }

      console.log(`[GeminiExecutor] Sending prompt (model=${modelLabel}, blocks=${promptBlocks.length})...`);
      const promptResult = await client.prompt(sessionId, promptBlocks);
      console.log(`[GeminiExecutor] Prompt completed, stopReason=${promptResult.stopReason}, model=${modelLabel}`);

      return {
        success: promptResult.stopReason !== 'refusal' && promptResult.stopReason !== 'cancelled',
        output: accumulatedOutput,
        sessionAbbr: sessionId.slice(0, 8),
      };
    } finally {
      // Clear activeOptions so stale callbacks don't fire after this call ends
      this.activeOptions = {};

      // If abort() was called and its timer is still pending, Gemini responded to
      // the cancel before the grace period elapsed.  Cancel the timer — the session
      // remains alive so the user can continue the conversation after aborting.
      if (this.abortTimer !== null) {
        clearTimeout(this.abortTimer);
        this.abortTimer = null;
      }
      this.inflightClient = null;
      this.inflightSessionId = null;
    }
  }

  /** Destroys the persistent client and clears all related state. */
  private destroyPersistentClient(): void {
    // Also cancel any pending abort grace-period timer so it doesn't fire
    // as a spurious no-op after the client is already gone.
    if (this.abortTimer !== null) {
      clearTimeout(this.abortTimer);
      this.abortTimer = null;
    }
    if (this.persistentClient) {
      this.persistentClient.destroy();
      this.persistentClient = null;
      this.persistentSessionId = null;
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
    if (msg.includes('invalid argument') || msg.includes('400')) {
      return `❌ Prompt too long (Context full). Try cleaning up with /compact or /clear.\n\nRaw error: ${msg}`;
    }
    if (msg.includes('exhausted your capacity') || msg.includes('quota') || msg.includes('No capacity available')) {
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
