import { spawn, ChildProcess } from 'child_process';
import { StringDecoder } from 'string_decoder';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DirectoryGuard } from '../security/DirectoryGuard';
import { IExecutor, ExecuteOptions, ExecuteResult } from './IExecutor';

export interface CodexExecutorOptions {
  /** Model passed as -m. Leave unset to use codex's default. */
  model?: string;
  /**
   * Bypass all approvals and the sandbox via
   * --dangerously-bypass-approvals-and-sandbox. Default: true.
   */
  autoApprove?: boolean;
  initialWorkingDirectory?: string;
  /** codex binary command. Default: 'codex' */
  codexCommand?: string;
  /** Thread ID for per-thread session persistence */
  threadId?: string;
  /**
   * Inactivity timeout: if codex produces no stdout for this long while a
   * command is in flight, the command fails and the process is killed.
   * Default: 10 minutes (matches ClaudePersistentExecutor).
   */
  inactivityTimeoutMs?: number;
  /** Grace period before SIGTERM escalates to SIGKILL. Default: 3000ms. */
  killEscalationMs?: number;
}

/** Default inactivity timeout (ms) — a silent codex process fails the command. */
const DEFAULT_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;
/** Default grace period (ms) before SIGTERM escalates to SIGKILL. */
const DEFAULT_KILL_ESCALATION_MS = 3_000;
/** How much stderr (chars) to keep for error diagnostics. */
const STDERR_TAIL_LIMIT = 4_000;
/** How much of the stderr tail (chars) to include in error messages. */
const STDERR_TAIL_IN_ERROR = 500;

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
  /** Terminal result recorded from turn.completed / turn.failed / error events. */
  result?: ExecuteResult;
}

/**
 * IExecutor implementation for the OpenAI Codex CLI (`codex`), exec mode.
 *
 * Unlike AgyExecutor (one persistent process per conversation), codex exec
 * is one-shot per command: each execute() spawns
 *   codex exec --json --skip-git-repo-check [--dangerously-bypass-approvals-and-sandbox] [-m model] "<prompt>"
 * and resolves when the process exits. Context continuity is achieved by
 * persisting the thread_id from `thread.started` and passing it to
 *   codex exec resume --skip-git-repo-check --json ... <thread_id> "<prompt>"
 * on subsequent commands.
 *
 * Caveats (verified against codex-cli 0.153.4):
 *  - stdin must be ended immediately after spawn — codex reads piped stdin
 *    to EOF before starting ("Reading additional input from stdin...").
 *  - `codex exec resume` does NOT accept the --sandbox flag (usage error).
 *    We only ever pass --dangerously-bypass-approvals-and-sandbox, which is
 *    accepted on both first run and resume.
 *  - item type "error" is non-fatal (e.g. model-metadata fallback warnings);
 *    turn.failed / top-level error events are the fatal ones.
 *
 * Note: exec mode accepts text prompts only — image attachments are silently
 * dropped (with a log line).
 */
export class CodexExecutor implements IExecutor {
  private directoryGuard: DirectoryGuard;
  private currentWorkingDirectory: string;

  private readonly model?: string;
  private readonly autoApprove: boolean;
  private readonly codexCommand: string;
  private readonly threadId?: string;

  private proc: ChildProcess | null = null;
  private codexThreadId: string | null = null;
  private sessionFilePath: string;

  private commandQueue: QueuedCommand[] = [];
  private isProcessing = false;
  private isDestroyed = false;
  private activeCommand: ActiveCommand | null = null;
  private currentOutputBuffer: string[] = [];
  private stdoutBuffer = '';
  private stderrTail = '';
  private decoder = new StringDecoder('utf8');
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly inactivityTimeoutMs: number;
  private readonly killEscalationMs: number;
  private attachmentWarningShown = false;

  constructor(directoryGuard: DirectoryGuard, options: CodexExecutorOptions = {}) {
    this.directoryGuard = directoryGuard;
    this.model = options.model;
    this.autoApprove = options.autoApprove ?? true;
    this.codexCommand = options.codexCommand ?? 'codex';
    this.threadId = options.threadId;
    this.inactivityTimeoutMs = options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;
    this.killEscalationMs = options.killEscalationMs ?? DEFAULT_KILL_ESCALATION_MS;

    if (options.initialWorkingDirectory) {
      try {
        this.currentWorkingDirectory = this.directoryGuard.resolveWorkingDirectory(
          options.initialWorkingDirectory
        );
      } catch (error) {
        console.warn(`[CodexExecutor] Failed to use initial working directory: ${options.initialWorkingDirectory}`, error);
        this.currentWorkingDirectory = process.cwd();
      }
    } else {
      this.currentWorkingDirectory = process.cwd();
    }

    if (this.threadId) {
      const sessionsDir = path.join(os.homedir(), '.remote-cli', 'codex-sessions');
      fs.mkdirSync(sessionsDir, { recursive: true });
      this.sessionFilePath = path.join(sessionsDir, `${this.threadId}.json`);
    } else {
      // Legacy: session file in working directory
      this.sessionFilePath = path.join(this.currentWorkingDirectory, '.codex-session');
    }
    this.loadThreadId();
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
    // One-shot processes: only the next spawn uses the new directory; a
    // running command keeps its own cwd.
    this.currentWorkingDirectory = this.directoryGuard.resolveWorkingDirectory(targetPath);
  }

  resetContext(): void {
    this.killProcess('Context reset');
    this.clearThreadId();
  }

  async abort(): Promise<boolean> {
    if (!this.proc || !this.activeCommand) return false;

    // codex exec has no cancel request in exec mode — abort = kill the
    // process. The thread id survives, so the next command resumes context.
    console.log('[CodexExecutor] Aborting: killing codex process');
    this.killProcess('Aborted by user');
    return true;
  }

  async destroy(): Promise<void> {
    if (this.isDestroyed) return;
    this.isDestroyed = true;

    // Reject everything still queued — nothing may spawn after destroy
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
    return this.codexThreadId;
  }

  /**
   * codex exec has no /compact equivalent. Dropping the thread id starts a
   * fresh session on the next command, which is the practical equivalent.
   */
  async compactWhenFull(onStream?: (chunk: string) => void): Promise<ExecuteResult> {
    if (!this.proc && !this.codexThreadId) {
      return { success: true, output: 'No active conversation to compact.' };
    }
    onStream?.('Resetting conversation context (codex exec has no /compact — starting fresh session)...\n');
    this.resetContext();
    return {
      success: true,
      output: 'Context reset: conversation history cleared. Next message starts a fresh codex session.',
    };
  }

  /**
   * Delete per-thread session state. Only removes OUR stored thread id
   * mapping — codex's own session store (~/.codex/sessions) is left untouched.
   */
  async deleteThreadData(_threadId: string): Promise<void> {
    await this.destroy();
    this.clearThreadId();
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
        console.warn('[CodexExecutor] codex exec mode accepts text prompts only — attachments were dropped');
      }

      let proc: ChildProcess;
      try {
        proc = this.spawnProcess(prompt);
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
          console.warn(`[CodexExecutor] Command timed out after ${options.timeout}ms, killing process`);
          this.killProcess(`Command timed out after ${options.timeout}ms`);
        }, options.timeout);
      }
      this.activeCommand = active;
      this.currentOutputBuffer = [];
      this.armInactivityTimer();
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
      result.sessionAbbr = this.codexThreadId?.slice(0, 8);
    }
    active.resolve(result);
  }

  /**
   * Arm the inactivity watchdog: any stdout line counts as activity. If codex
   * goes silent mid-command for longer than the limit, fail the command and
   * kill the process (the thread resumes on the next command).
   */
  private armInactivityTimer(): void {
    this.clearInactivityTimer();
    this.inactivityTimer = setTimeout(() => {
      console.warn(`[CodexExecutor] No output for ${this.inactivityTimeoutMs}ms, killing process`);
      this.killProcess(`No output from codex for ${this.inactivityTimeoutMs}ms (inactivity timeout)`);
    }, this.inactivityTimeoutMs);
  }

  private clearInactivityTimer(): void {
    if (this.inactivityTimer !== null) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }
  }

  // ─── Process lifecycle ────────────────────────────────────────────────────

  private spawnProcess(prompt: string): ChildProcess {
    if (this.isDestroyed) {
      throw new Error('Executor has been destroyed');
    }

    const args = this.buildArgs(prompt);
    console.log(`[CodexExecutor] Spawning: ${this.codexCommand} ${args.join(' ')} (cwd: ${this.currentWorkingDirectory})`);

    // Fresh stream state for the new process
    this.stdoutBuffer = '';
    this.stderrTail = '';
    this.decoder = new StringDecoder('utf8');

    const proc = spawn(this.codexCommand, args, {
      cwd: this.currentWorkingDirectory,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.stdout!.on('data', (data: Buffer) => this.handleStdout(proc, data));
    proc.stderr!.on('data', (data: Buffer) => {
      if (proc !== this.proc) return; // stale process — don't pollute the next command's diagnostics
      const text = data.toString();
      // Keep a bounded tail for error diagnostics (usage errors, auth failures)
      this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_LIMIT);
      console.log(`[CodexExecutor stderr] ${text.trim().slice(0, 300)}`);
    });
    // Async stdin socket errors (e.g. EPIPE if codex exits early) must not
    // crash the whole CLI process — the exit/error handler reports the failure.
    proc.stdin!.on('error', (error: Error) => {
      console.warn(`[CodexExecutor] stdin error: ${error.message}`);
    });

    proc.on('error', (error) => {
      if (proc !== this.proc) return;
      console.error('[CodexExecutor] Process error:', error);
      this.proc = null;
      const friendly = error.message.includes('ENOENT')
        ? 'Codex CLI (codex) is not installed or not found on PATH. Install it with `npm i -g @openai/codex`, or use /backend to switch to another backend.'
        : `codex process error: ${error.message}`;
      this.completeActiveCommand({ success: false, error: friendly });
    });

    proc.on('exit', (code, signal) => {
      if (proc !== this.proc) return;
      // 'exit' fires when the process terminates, but its stdio streams may
      // still hold undelivered data — terminal resolution happens on 'close'
      // (all stdio flushed) so the final turn.completed line is never lost.
      console.log(`[CodexExecutor] Process exited (code=${code}, signal=${signal})`);
    });

    proc.on('close', (code, signal) => {
      if (proc !== this.proc) return;
      this.proc = null;
      // Flush the decoder and any unterminated trailing line before judging
      // the outcome — a crash mid-write can leave a complete final event
      // (e.g. turn.failed with the real error) without a trailing newline.
      this.stdoutBuffer += this.decoder.end();
      const remaining = this.stdoutBuffer;
      this.stdoutBuffer = '';
      for (const line of remaining.split('\n')) {
        if (line.trim()) this.handleLine(line);
      }
      if (this.activeCommand) {
        const recorded = this.activeCommand.result;
        if (recorded) {
          // A terminal event (turn.completed / turn.failed / error) already
          // determined the outcome — trust it over the exit code.
          this.completeActiveCommand(recorded);
        } else {
          console.error(`[CodexExecutor] Process exited without a terminal event (code=${code}, signal=${signal})`);
          const tail = this.stderrTail.trim().slice(-STDERR_TAIL_IN_ERROR);
          this.completeActiveCommand({
            success: false,
            error: `codex process exited unexpectedly (code ${code ?? signal})${tail ? `: ${tail}` : ''}`,
          });
        }
      }
    });

    this.proc = proc;

    // codex exec reads piped stdin to EOF before starting — end it immediately.
    try {
      proc.stdin!.end();
    } catch { /* already closed */ }

    return proc;
  }

  private buildArgs(prompt: string): string[] {
    const args = ['exec'];
    if (this.codexThreadId) {
      // NOTE: `codex exec resume` rejects --sandbox (usage error in 0.153.4).
      // --dangerously-bypass-approvals-and-sandbox IS accepted on resume.
      args.push('resume', '--skip-git-repo-check', '--json');
      if (this.autoApprove) {
        args.push('--dangerously-bypass-approvals-and-sandbox');
      }
      if (this.model) {
        args.push('-m', this.model);
      }
      // `--` guards prompts that start with a dash from clap's flag parser
      args.push(this.codexThreadId, '--', prompt);
      return args;
    }

    args.push('--json', '--skip-git-repo-check');
    if (this.autoApprove) {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    }
    if (this.model) {
      args.push('-m', this.model);
    }
    args.push('--', prompt);
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
      // process would share the thread rollout store with the next spawn.
      const escalate = setTimeout(() => {
        if (!exited) {
          console.warn('[CodexExecutor] Process ignored SIGTERM, escalating to SIGKILL');
          proc.kill('SIGKILL');
        }
      }, this.killEscalationMs);
      // Never let the watchdog hold the event loop open by itself
      if (typeof escalate.unref === 'function') escalate.unref();
    }
    // Never leave an in-flight command hanging when its process dies. If a
    // terminal event already recorded an outcome (e.g. turn.completed arrived
    // but the process then hung), prefer it over the kill reason.
    if (this.activeCommand) {
      this.completeActiveCommand(
        this.activeCommand.result ?? {
          success: false,
          error: reason ?? 'codex process was terminated mid-command',
        }
      );
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
      console.warn(`[CodexExecutor] Skipping malformed NDJSON line: ${line.slice(0, 120)}`);
      return;
    }

    // Any valid line counts as activity for the inactivity watchdog
    if (this.activeCommand) this.armInactivityTimer();

    switch (message.type) {
      case 'thread.started': {
        const threadId = message.thread_id;
        if (typeof threadId === 'string' && threadId) {
          if (threadId !== this.codexThreadId) {
            console.log(`[CodexExecutor] Thread started: ${threadId}`);
            this.setThreadId(threadId);
          }
        }
        break;
      }

      case 'turn.started':
        // Marks the start of model work for this turn — nothing to emit
        break;

      case 'item.started':
        this.handleItemStarted(message.item);
        break;

      case 'item.completed':
        this.handleItemCompleted(message.item);
        break;

      case 'turn.completed':
        if (this.activeCommand) {
          this.activeCommand.result = {
            success: true,
            output: this.currentOutputBuffer.join(''),
          };
        }
        break;

      case 'turn.failed': {
        const errMsg = message.error?.message || 'turn failed (no details)';
        if (this.activeCommand) {
          this.activeCommand.result = { success: false, error: errMsg };
        }
        break;
      }

      case 'error': {
        const errMsg = typeof message.message === 'string' ? message.message : 'codex error';
        // Transient reconnect/fallback notices are informational only
        if (/Reconnecting|Falling back/i.test(errMsg)) {
          console.warn(`[CodexExecutor] Transient error event: ${errMsg}`);
          break;
        }
        if (this.activeCommand) {
          this.activeCommand.result = { success: false, error: errMsg };
        }
        break;
      }

      default:
        // Unknown events are safely ignored (codex may add new ones)
        console.warn(`[CodexExecutor] Ignoring unknown event: ${message.type}`);
    }
  }

  private handleItemStarted(item: any): void {
    if (!item || !this.activeCommand) return;
    const { options } = this.activeCommand;

    // command_execution has its full command string at start; other tool
    // types (web_search etc.) have empty fields until item.completed.
    if (item.type === 'command_execution' && typeof item.id === 'string') {
      options.onToolUse?.({
        id: item.id,
        name: 'Bash',
        input: { command: item.command ?? '' },
      });
    }
  }

  private handleItemCompleted(item: any): void {
    if (!item || !this.activeCommand) return;
    const { options } = this.activeCommand;
    const itemId = typeof item.id === 'string' ? item.id : 'codex-item';

    switch (item.type) {
      case 'agent_message':
      case 'message': {
        const text = item.text;
        if (typeof text === 'string' && text.length > 0) {
          this.currentOutputBuffer.push(text);
          options.onStream?.(text);
        }
        return;
      }

      case 'command_execution': {
        const output = typeof item.aggregated_output === 'string' ? item.aggregated_output : '';
        const isError = !codexItemSucceeded(item.status, item.exit_code);
        options.onToolResult?.({ tool_use_id: itemId, content: output, is_error: isError });
        return;
      }

      case 'file_change': {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        const firstPath = changes[0]?.path ?? '';
        const kinds = changes.map((c: any) => c?.kind).filter(Boolean).join(', ');
        const status = typeof item.status === 'string' ? item.status : '';
        options.onToolUse?.({ id: itemId, name: 'Edit', input: { file_path: firstPath } });
        options.onToolResult?.({
          tool_use_id: itemId,
          content: `file_change (${kinds || 'unknown'}): ${status}`,
          is_error: !codexItemSucceeded(item.status, null),
        });
        return;
      }

      case 'web_search': {
        const query = item.query ?? item.action?.queries?.[0] ?? '';
        options.onToolUse?.({ id: itemId, name: 'WebSearch', input: { query } });
        options.onToolResult?.({ tool_use_id: itemId, content: '', is_error: false });
        return;
      }

      case 'reasoning':
        // Model reasoning summaries are not surfaced to the user
        return;

      case 'function_call_output':
        // Companion record of a function_call — already rendered by it
        return;

      case 'error':
        // Non-fatal item-level error (e.g. model-metadata fallback warnings)
        console.warn(`[CodexExecutor] Item error: ${item.message ?? '(no message)'}`);
        return;

      default:
        // Unknown tool-ish items (mcp_tool_call, future types): ignore quietly
        return;
    }
  }

  // ─── Thread persistence ───────────────────────────────────────────────────

  private loadThreadId(): void {
    try {
      if (fs.existsSync(this.sessionFilePath)) {
        const data = fs.readFileSync(this.sessionFilePath, 'utf-8');
        const session = JSON.parse(data);
        if (session.id) {
          this.codexThreadId = session.id;
          console.log(`[CodexExecutor] Loaded thread ID: ${this.codexThreadId}`);
        }
      }
    } catch (error) {
      console.error('[CodexExecutor] Failed to load thread ID:', error);
      this.codexThreadId = null;
    }
  }

  private setThreadId(threadId: string): void {
    this.codexThreadId = threadId;
    try {
      const data = JSON.stringify({ id: threadId, savedAt: new Date().toISOString() });
      fs.writeFileSync(this.sessionFilePath, data, 'utf-8');
    } catch (error) {
      console.error('[CodexExecutor] Failed to save thread ID:', error);
    }
  }

  private clearThreadId(): void {
    this.codexThreadId = null;
    try {
      if (fs.existsSync(this.sessionFilePath)) {
        fs.unlinkSync(this.sessionFilePath);
      }
    } catch (error) {
      console.error('[CodexExecutor] Failed to delete session file:', error);
    }
  }
}

/**
 * A command_execution / file_change item succeeded when its exit code is 0
 * (if present) or its status is a success word.
 */
function codexItemSucceeded(status: unknown, exitCode: unknown): boolean {
  if (typeof exitCode === 'number') {
    return exitCode === 0;
  }
  const s = typeof status === 'string' ? status.trim().toLowerCase() : '';
  return s === 'completed' || s === 'success' || s === 'succeeded' || s === 'ok';
}
