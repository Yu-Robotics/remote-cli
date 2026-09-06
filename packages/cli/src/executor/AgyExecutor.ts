import { spawn, ChildProcess } from 'child_process';
import { StringDecoder } from 'string_decoder';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DirectoryGuard } from '../security/DirectoryGuard';
import { IExecutor, ExecuteOptions, ExecuteResult } from './IExecutor';

export interface AgyExecutorOptions {
  /** Model slug passed as --model. Leave unset to use agy's default. */
  model?: string;
  /** Auto-approve all tool permissions via --dangerously-skip-permissions. Default: true. */
  autoApprove?: boolean;
  initialWorkingDirectory?: string;
  /** agy binary command. Default: 'agy' */
  agyCommand?: string;
  /** Thread ID for per-thread conversation persistence */
  threadId?: string;
  /**
   * Inactivity timeout: if agy produces no stdout for this long while a
   * command is in flight, the command fails and the process is killed.
   * Default: 10 minutes (matches ClaudePersistentExecutor).
   */
  inactivityTimeoutMs?: number;
  /** Grace period before SIGTERM escalates to SIGKILL. Default: 3000ms. */
  killEscalationMs?: number;
}

/** Default inactivity timeout (ms) — a silent agy process fails the command. */
const DEFAULT_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;
/** Default grace period (ms) before SIGTERM escalates to SIGKILL. */
const DEFAULT_KILL_ESCALATION_MS = 3_000;

/**
 * Map an AGY tool call to a Claude-compatible { name, input } shape so the
 * router's ToolFormatter renders it with the same card style as Claude tools.
 * Unknown tools keep their raw name and parameters (generic rendering).
 *
 * AGY parameter keys are PascalCase (e.g. run_command takes `CommandLine`).
 */
function mapAgyTool(
  toolName: string,
  parameters: Record<string, unknown>,
): { name: string; input: Record<string, unknown> } {
  switch (toolName) {
    case 'run_command':
      return { name: 'Bash', input: { command: parameters.CommandLine ?? '' } };
    case 'view_file':
      return { name: 'Read', input: { file_path: parameters.AbsolutePath ?? parameters.Path ?? '' } };
    case 'write_to_file':
      return { name: 'Write', input: { file_path: parameters.AbsolutePath ?? parameters.Path ?? '' } };
    case 'replace_file_content':
    case 'multi_replace_file_content':
    case 'sed_file':
      return { name: 'Edit', input: { file_path: parameters.AbsolutePath ?? parameters.Path ?? '' } };
    case 'grep_search':
      return { name: 'Grep', input: parameters };
    case 'find_by_name':
      return { name: 'Glob', input: parameters };
    case 'search_web':
      return { name: 'WebSearch', input: { query: parameters.Query ?? '' } };
    case 'read_url_content':
      return { name: 'WebFetch', input: { url: parameters.Url ?? '' } };
    default:
      return { name: toolName, input: parameters };
  }
}

/** Result statuses that mean the turn was aborted rather than failed. */
const ABORTED_STATUSES = new Set(['INTERRUPTED', 'CANCELED']);

interface QueuedCommand {
  prompt: string;
  options: ExecuteOptions;
  resolve: (result: ExecuteResult) => void;
  reject: (error: Error) => void;
}

interface ActiveCommand {
  options: ExecuteOptions;
  resolve: (result: ExecuteResult) => void;
  timeoutTimer?: ReturnType<typeof setTimeout>;
}

/**
 * IExecutor implementation for the Antigravity CLI (`agy`) — Google's
 * agentic CLI from the Antigravity suite.
 *
 * agy speaks a Claude-Code-style stream-json protocol: one persistent
 * process per conversation, NDJSON prompts in on stdin
 * ({"event":"user","message":{"content":"..."}}), NDJSON events out on
 * stdout (init / step_update / result). Conversations survive process
 * restarts via `--conversation <id>`, which we persist per thread.
 *
 * The process is respawned (resuming the conversation) when:
 *  - setWorkingDirectory() changes cwd
 *  - the process exits unexpectedly
 *  - abort() kills it mid-command
 * resetContext()/compactWhenFull() additionally drop the conversation id,
 * so the next command starts a fresh session (agy has no /compact).
 *
 * Note: agy stream-json input supports text blocks only — image
 * attachments are silently dropped (with a log line).
 */
export class AgyExecutor implements IExecutor {
  private directoryGuard: DirectoryGuard;
  private currentWorkingDirectory: string;

  private readonly model?: string;
  private readonly autoApprove: boolean;
  private readonly agyCommand: string;
  private readonly threadId?: string;

  private proc: ChildProcess | null = null;
  private conversationId: string | null = null;
  private sessionFilePath: string;

  private commandQueue: QueuedCommand[] = [];
  private isProcessing = false;
  private isDestroyed = false;
  private activeCommand: ActiveCommand | null = null;
  private currentOutputBuffer: string[] = [];
  private stdoutBuffer = '';
  private decoder = new StringDecoder('utf8');
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly inactivityTimeoutMs: number;
  private readonly killEscalationMs: number;
  private attachmentWarningShown = false;

  constructor(directoryGuard: DirectoryGuard, options: AgyExecutorOptions = {}) {
    this.directoryGuard = directoryGuard;
    this.model = options.model;
    this.autoApprove = options.autoApprove ?? true;
    this.agyCommand = options.agyCommand ?? 'agy';
    this.threadId = options.threadId;
    this.inactivityTimeoutMs = options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;
    this.killEscalationMs = options.killEscalationMs ?? DEFAULT_KILL_ESCALATION_MS;

    if (options.initialWorkingDirectory) {
      try {
        this.currentWorkingDirectory = this.directoryGuard.resolveWorkingDirectory(
          options.initialWorkingDirectory
        );
      } catch (error) {
        console.warn(`[AgyExecutor] Failed to use initial working directory: ${options.initialWorkingDirectory}`, error);
        this.currentWorkingDirectory = process.cwd();
      }
    } else {
      this.currentWorkingDirectory = process.cwd();
    }

    if (this.threadId) {
      const sessionsDir = path.join(os.homedir(), '.remote-cli', 'agy-sessions');
      fs.mkdirSync(sessionsDir, { recursive: true });
      this.sessionFilePath = path.join(sessionsDir, `${this.threadId}.json`);
    } else {
      // Legacy: session file in working directory
      this.sessionFilePath = path.join(this.currentWorkingDirectory, '.agy-session');
    }
    this.loadConversationId();
  }

  // ─── IExecutor required ───────────────────────────────────────────────────

  async execute(prompt: string, options: ExecuteOptions = {}): Promise<ExecuteResult> {
    if (this.isDestroyed) {
      return Promise.reject(new Error('Executor has been destroyed'));
    }
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

    // Changing cwd requires a respawn (tools run relative to the process cwd).
    // The conversation id is kept, so the respawn resumes context.
    const needsRestart = this.currentWorkingDirectory !== resolved && this.proc !== null;
    this.currentWorkingDirectory = resolved;

    if (needsRestart) {
      console.log(`[AgyExecutor] Restarting process in new directory: ${resolved}`);
      this.killProcess();
    }
  }

  resetContext(): void {
    this.killProcess();
    this.clearConversationId();
  }

  async abort(): Promise<boolean> {
    if (!this.proc || !this.activeCommand) return false;

    // agy's stream-json protocol has no cancel request (control_request is
    // explicitly unsupported), so abort = kill the process. The conversation
    // id survives, so the next command resumes context.
    console.log('[AgyExecutor] Aborting: killing agy process');
    this.killProcess('Aborted by user');
    return true;
  }

  async destroy(): Promise<void> {
    if (this.isDestroyed) return;
    this.isDestroyed = true;

    // Reject everything still queued — nothing may respawn after destroy
    const queued = this.commandQueue.splice(0);
    for (const command of queued) {
      command.reject(new Error('Executor has been destroyed'));
    }

    const proc = this.proc;
    if (proc) {
      try {
        proc.stdin?.end();
      } catch { /* already closed */ }
    }
    this.killProcess('Executor destroyed');
  }

  // ─── IExecutor optional ───────────────────────────────────────────────────

  isProcessRunning(): boolean {
    return this.proc !== null;
  }

  getSessionId(): string | null {
    return this.conversationId;
  }

  /**
   * agy has no /compact equivalent. Dropping the conversation id starts a
   * fresh session on the next command, which is the practical equivalent.
   */
  async compactWhenFull(onStream?: (chunk: string) => void): Promise<ExecuteResult> {
    if (!this.proc && !this.conversationId) {
      return { success: true, output: 'No active conversation to compact.' };
    }
    onStream?.('Resetting conversation context (agy has no /compact — starting fresh session)...\n');
    this.resetContext();
    return {
      success: true,
      output: 'Context reset: conversation history cleared. Next message starts a fresh agy session.',
    };
  }

  /**
   * Delete per-thread conversation state. Only removes OUR stored
   * conversation id mapping — agy's own conversation store
   * (~/.gemini/antigravity-cli/conversations) is left untouched.
   */
  async deleteThreadData(_threadId: string): Promise<void> {
    await this.destroy();
    this.clearConversationId();
  }

  // ─── Queue processing ─────────────────────────────────────────────────────

  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.isDestroyed || this.commandQueue.length === 0) return;

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
      void this.processQueue();
    }
  }

  private executeQueued(prompt: string, options: ExecuteOptions): Promise<ExecuteResult> {
    return new Promise((resolve) => {
      if (options.attachments?.length && !this.attachmentWarningShown) {
        this.attachmentWarningShown = true;
        console.warn('[AgyExecutor] agy stream-json input supports text only — attachments were dropped');
      }

      let proc: ChildProcess;
      try {
        proc = this.ensureProcess();
      } catch (error) {
        resolve({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      const active: ActiveCommand = { options, resolve };
      if (options.timeout && options.timeout > 0) {
        active.timeoutTimer = setTimeout(() => {
          console.warn(`[AgyExecutor] Command timed out after ${options.timeout}ms, killing process`);
          this.killProcess(`Command timed out after ${options.timeout}ms`);
        }, options.timeout);
      }
      this.activeCommand = active;
      this.currentOutputBuffer = [];
      this.armInactivityTimer();

      const line = JSON.stringify({
        event: 'user',
        message: { content: prompt },
      }) + '\n';

      try {
        proc.stdin!.write(line);
      } catch (error) {
        this.completeActiveCommand({
          success: false,
          error: `Failed to send prompt to agy: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    });
  }

  private completeActiveCommand(result: ExecuteResult): void {
    const active = this.activeCommand;
    if (!active) return;
    this.activeCommand = null;
    this.clearInactivityTimer();
    if (active.timeoutTimer) clearTimeout(active.timeoutTimer);
    if (result.success && result.output === undefined) {
      result.output = this.currentOutputBuffer.join('');
    }
    if (result.success) {
      result.sessionAbbr = this.conversationId?.slice(0, 8);
    }
    active.resolve(result);
  }

  /**
   * Arm the inactivity watchdog: any stdout line counts as activity. If agy
   * goes silent mid-command for longer than the limit, fail the command and
   * kill the process (the conversation resumes on the next command).
   */
  private armInactivityTimer(): void {
    this.clearInactivityTimer();
    this.inactivityTimer = setTimeout(() => {
      console.warn(`[AgyExecutor] No output for ${this.inactivityTimeoutMs}ms, killing process`);
      this.killProcess(`No output from agy for ${this.inactivityTimeoutMs}ms (inactivity timeout)`);
    }, this.inactivityTimeoutMs);
  }

  private clearInactivityTimer(): void {
    if (this.inactivityTimer !== null) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }
  }

  // ─── Process lifecycle ────────────────────────────────────────────────────

  private ensureProcess(): ChildProcess {
    if (this.proc) return this.proc;
    if (this.isDestroyed) {
      throw new Error('Executor has been destroyed');
    }

    const args = this.buildArgs();
    console.log(`[AgyExecutor] Spawning: ${this.agyCommand} ${args.join(' ')} (cwd: ${this.currentWorkingDirectory})`);

    // Fresh stream state for the new process
    this.stdoutBuffer = '';
    this.decoder = new StringDecoder('utf8');

    const proc = spawn(this.agyCommand, args, {
      cwd: this.currentWorkingDirectory,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.stdout!.on('data', (data: Buffer) => this.handleStdout(proc, data));
    proc.stderr!.on('data', (data: Buffer) => {
      // Diagnostics (progress, permission notices) — log only
      console.log(`[AgyExecutor stderr] ${data.toString().trim().slice(0, 300)}`);
    });
    // Async stdin socket errors (e.g. EPIPE if agy exits mid-write) must not
    // crash the whole CLI process — the exit/error handler reports the failure.
    proc.stdin!.on('error', (error: Error) => {
      console.warn(`[AgyExecutor] stdin error: ${error.message}`);
    });

    proc.on('error', (error) => {
      if (proc !== this.proc) return;
      console.error('[AgyExecutor] Process error:', error);
      this.proc = null;
      const friendly = error.message.includes('ENOENT')
        ? 'AGY CLI (agy) is not installed or not found on PATH. Install it from https://antigravity.google/cli, or use /backend to switch to another backend.'
        : `agy process error: ${error.message}`;
      this.completeActiveCommand({ success: false, error: friendly });
    });

    proc.on('exit', (code, signal) => {
      if (proc !== this.proc) return;
      this.proc = null;
      if (this.activeCommand) {
        console.error(`[AgyExecutor] Process exited unexpectedly (code=${code}, signal=${signal})`);
        this.completeActiveCommand({
          success: false,
          error: `agy process exited unexpectedly (code ${code ?? signal}). The conversation will resume on the next command.`,
        });
      }
    });

    this.proc = proc;
    return proc;
  }

  private buildArgs(): string[] {
    const args = ['--input-format=stream-json', '--output-format=stream-json'];
    if (this.autoApprove) {
      args.push('--dangerously-skip-permissions');
    }
    if (this.model) {
      args.push('--model', this.model);
    }
    if (this.conversationId) {
      args.push('--conversation', this.conversationId);
    }
    return args;
  }

  private killProcess(reason?: string): void {
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      let exited = false;
      proc.once('exit', () => { exited = true; });
      proc.kill(); // SIGTERM

      // Escalate to SIGKILL if the process ignores SIGTERM — a lingering
      // process would share the conversation store with the next respawn.
      const escalate = setTimeout(() => {
        if (!exited) {
          console.warn('[AgyExecutor] Process ignored SIGTERM, escalating to SIGKILL');
          proc.kill('SIGKILL');
        }
      }, this.killEscalationMs);
      // Never let the watchdog hold the event loop open by itself
      if (typeof escalate.unref === 'function') escalate.unref();
    }
    // Never leave an in-flight command hanging when its process dies.
    if (this.activeCommand) {
      this.completeActiveCommand({
        success: false,
        error: reason ?? 'agy process was terminated mid-command',
      });
    }
  }

  // ─── Wire protocol parsing ────────────────────────────────────────────────

  private handleStdout(proc: ChildProcess, data: Buffer): void {
    if (proc !== this.proc) return; // stale process
    // StringDecoder handles multi-byte UTF-8 characters split across chunks
    this.stdoutBuffer += this.decoder.write(data);
    const lines = this.stdoutBuffer.split('\n');
    this.stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      console.warn(`[AgyExecutor] Skipping malformed NDJSON line: ${line.slice(0, 120)}`);
      return;
    }

    // Any valid line counts as activity for the inactivity watchdog
    if (this.activeCommand) this.armInactivityTimer();

    switch (message.event) {
      case 'init': {
        const conversationId = message.conversation_id;
        if (typeof conversationId === 'string' && conversationId) {
          console.log(`[AgyExecutor] Conversation initialized: ${conversationId}`);
          this.setConversationId(conversationId);
        }
        break;
      }

      case 'step_update':
        this.handleStepUpdate(message.step_update);
        break;

      case 'result':
        this.handleResult(message.result);
        break;

      default:
        // Unknown events are safely ignored (agy may add new ones)
        console.warn(`[AgyExecutor] Ignoring unknown event: ${message.event}`);
    }
  }

  private handleStepUpdate(step: any): void {
    if (!step || !this.activeCommand) return;
    const { options } = this.activeCommand;

    if (step.step_type === 'agent_response') {
      const delta = step.text_delta;
      if (typeof delta === 'string' && delta.length > 0) {
        this.currentOutputBuffer.push(delta);
        options.onStream?.(delta);
      }
      return;
    }

    if (step.step_type === 'tool' && typeof step.tool_name === 'string') {
      const toolUseId = `agy-step-${step.step_index}`;
      const toolInfo = step.tool_info ?? {};
      const parameters = (toolInfo.parameters ?? {}) as Record<string, unknown>;

      if (step.state === 'ACTIVE') {
        const { name, input } = mapAgyTool(step.tool_name, parameters);
        options.onToolUse?.({ id: toolUseId, name, input });
      } else if (step.state === 'DONE') {
        const isError = !!toolInfo.error;
        const content =
          typeof toolInfo.output === 'string'
            ? toolInfo.output
            : (toolInfo.error?.message ?? '');
        options.onToolResult?.({ tool_use_id: toolUseId, content, is_error: isError });
      }
      return;
    }

    // user_input / system_message / checkpoint / unknown step types: ignore
  }

  private handleResult(result: any): void {
    if (!result || !this.activeCommand) {
      // Late result from an aborted/killed turn — nothing to complete
      return;
    }

    const conversationId = result.conversation_id;
    if (typeof conversationId === 'string' && conversationId && conversationId !== this.conversationId) {
      this.setConversationId(conversationId);
    }

    if (result.status === 'SUCCESS') {
      const accumulated = this.currentOutputBuffer.join('');
      this.completeActiveCommand({
        success: true,
        output: accumulated || result.response || '',
      });
      return;
    }

    if (ABORTED_STATUSES.has(result.status)) {
      this.completeActiveCommand({ success: false, error: `Command ${String(result.status).toLowerCase()}` });
      return;
    }

    this.completeActiveCommand({
      success: false,
      error: result.error || `agy command failed with status ${result.status}`,
    });
  }

  // ─── Conversation persistence ─────────────────────────────────────────────

  private loadConversationId(): void {
    try {
      if (fs.existsSync(this.sessionFilePath)) {
        const data = fs.readFileSync(this.sessionFilePath, 'utf-8');
        const session = JSON.parse(data);
        if (session.id) {
          this.conversationId = session.id;
          console.log(`[AgyExecutor] Loaded conversation ID: ${this.conversationId}`);
        }
      }
    } catch (error) {
      console.error('[AgyExecutor] Failed to load conversation ID:', error);
      this.conversationId = null;
    }
  }

  private setConversationId(conversationId: string): void {
    this.conversationId = conversationId;
    try {
      const data = JSON.stringify({ id: conversationId, savedAt: new Date().toISOString() });
      fs.writeFileSync(this.sessionFilePath, data, 'utf-8');
    } catch (error) {
      console.error('[AgyExecutor] Failed to save conversation ID:', error);
    }
  }

  private clearConversationId(): void {
    this.conversationId = null;
    try {
      if (fs.existsSync(this.sessionFilePath)) {
        fs.unlinkSync(this.sessionFilePath);
      }
    } catch (error) {
      console.error('[AgyExecutor] Failed to delete conversation file:', error);
    }
  }
}
