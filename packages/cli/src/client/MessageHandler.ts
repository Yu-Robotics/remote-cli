import { WebSocketClient } from './WebSocketClient';
import { DirectoryGuard } from '../security/DirectoryGuard';
import { IncomingMessage, OutgoingMessage, StructuredContent, ToolUseInfo, ToolResultInfo } from '../types';
import type { IExecutor } from '../executor/IExecutor';
import { createExecutor } from '../executor';
import { FeishuNotificationAdapter } from '../hooks';
import { ConfigManager } from '../config/ConfigManager';
import { processFileReadContent } from '../utils/FileReadDetector';
import { spawn, execFile } from 'child_process';
import type { ExecutorConfig } from '../types/config';
import type { ThreadManager } from '../thread/ThreadManager';
import type { Thread } from '../thread/types';

/**
 * Detected backend information
 */
interface BackendInfo {
  id: 'auto' | 'gemini';
  label: string;
  installed: boolean;
}

/**
 * Legacy message type for backward compatibility
 */
export interface Message {
  type: string;
  messageId?: string;
  content?: string;
  timestamp?: number;
}

/**
 * Message Handler
 * Responsible for handling messages from WebSocket and invoking Claude executor
 */
export class MessageHandler {
  private wsClient: WebSocketClient;
  private executor: IExecutor;
  private directoryGuard: DirectoryGuard;
  private config: ConfigManager;
  private isDestroyed = false;
  private isExecuting = false;
  private currentOpenId?: string;
  private notificationAdapter: FeishuNotificationAdapter;
  private threadManager?: ThreadManager;

  constructor(
    wsClient: WebSocketClient,
    executor: IExecutor,
    directoryGuard: DirectoryGuard,
    config: ConfigManager,
    threadManager?: ThreadManager
  ) {
    this.wsClient = wsClient;
    this.executor = executor;
    this.directoryGuard = directoryGuard;
    this.config = config;
    this.threadManager = threadManager;

    if (threadManager) {
      // Enable external session management so directory changes don't wipe session
      (executor as any).enableExternalSessionManagement?.();
    }

    // Initialize Feishu notification adapter
    this.notificationAdapter = new FeishuNotificationAdapter(wsClient);
    this.notificationAdapter.register();
  }

  /**
   * Handle message (supports new IncomingMessage format)
   * @param message Message object
   */
  async handleMessage(message: Message | IncomingMessage): Promise<void> {
    // Check if already destroyed
    if (this.isDestroyed) {
      return;
    }

    // Validate message structure
    if (!message || !this.isValidMessage(message)) {
      this.sendResponse(message?.messageId || 'unknown', {
        success: false,
        error: 'Invalid message format',
      });
      return;
    }

    // Handle different types of messages
    switch (message.type) {
      case 'status':
        await this.handleStatusQuery(message.messageId!);
        return;

      case 'command':
        await this.handleCommandMessage(message as IncomingMessage);
        return;

      case 'heartbeat':
        // Silently ignore heartbeat responses from server
        return;

      case 'binding_confirm':
        // Silently ignore binding confirmation from server
        return;

      default:
        this.sendResponse(message.messageId!, {
          success: false,
          error: `Unknown message type: ${message.type}`,
        });
    }
  }

  /**
   * Handle command message
   */
  private async handleCommandMessage(message: IncomingMessage): Promise<void> {
    const { messageId, content, workingDirectory, openId, isSlashCommand } = message;

    // Store openId for response routing and notifications
    this.currentOpenId = openId;
    this.notificationAdapter.setCurrentOpenId(openId);

    // Handle /abort command first, even when busy
    if (content?.trim() === '/abort') {
      await this.handleAbortCommand(messageId);
      return;
    }

    // Check if executor is waiting for interactive input
    if ('isWaitingInput' in this.executor && typeof this.executor.isWaitingInput === 'function') {
      const executor = this.executor as { isWaitingInput(): boolean; sendInput(input: string): boolean };
      if (executor.isWaitingInput()) {
        const input = content?.trim();
        if (input) {
          const sent = executor.sendInput(input);
          if (sent) {
            this.sendResponse(messageId, {
              success: true,
              output: `✅ Sent: "${input}"`,
            });
          } else {
            this.sendResponse(messageId, {
              success: false,
              error: '❌ Failed to send input - executor is no longer waiting',
            });
          }
        } else {
          this.sendResponse(messageId, {
            success: false,
            error: '❌ Please provide a non-empty input',
          });
        }
        return;
      }
    }

    // Check if there is a task currently executing
    if (this.isExecuting) {
      this.sendResponse(messageId, {
        success: false,
        error: 'Executor is busy, please wait for current task to complete. Send the abort command to cancel the running task.',
      });
      return;
    }

    // If working directory is provided, validate and set it
    if (workingDirectory) {
      // Verify directory is in the whitelist
      if (!this.directoryGuard.isSafePath(workingDirectory)) {
        this.sendResponse(messageId, {
          success: false,
          error: `Directory not in whitelist: ${workingDirectory}\n\nAllowed directories:\n${this.directoryGuard
            .getAllowedDirectories()
            .map((d) => `• ${d}`)
            .join('\n')}`,
        });
        return;
      }

      // Set working directory
      await this.executor.setWorkingDirectory(workingDirectory);
    }

    try {
      this.isExecuting = true;

      // Handle built-in commands (except /abort which was handled above)
      const builtInResult = await this.handleBuiltInCommand(messageId, content!);
      if (builtInResult) {
        return;
      }

      // Check if this is a passthrough slash command from server
      if (isSlashCommand) {
        console.log(`[MessageHandler] Executing passthrough slash command: ${content}`);
        await this.executeSlashCommand(messageId, content!);
        return;
      }

      // Expand command shortcuts
      const expandedContent = this.expandCommandShortcuts(content!);

      // Detect file-reading intent and inject hint for mobile optimization
      const processedContent = processFileReadContent(expandedContent);

      // Execute Claude command
      await this.executeCommand(messageId, processedContent);
    } catch (error) {
      this.sendResponse(messageId, {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      this.isExecuting = false;
    }
  }

  /**
   * Handle abort command
   * Can be executed even when executor is busy
   */
  private async handleAbortCommand(messageId: string): Promise<void> {
    const wasExecuting = this.isExecuting;
    const aborted = await this.executor.abort();

    if (aborted) {
      this.isExecuting = false;
      this.sendResponse(messageId, {
        success: true,
        output: wasExecuting
          ? '✅ Current command has been aborted'
          : '⚠️ No command was executing, but executor has been reset',
      });
    } else {
      this.sendResponse(messageId, {
        success: true,
        output: 'ℹ️ No command is currently executing',
      });
    }
  }

  /**
   * Handle status query
   */
  private async handleStatusQuery(messageId: string): Promise<void> {
    this.wsClient.send({
      type: 'status',
      messageId,
      status: {
        connected: this.wsClient.isConnected(),
        allowedDirectories: this.directoryGuard.getAllowedDirectories(),
        currentWorkingDirectory: this.executor.getCurrentWorkingDirectory(),
      },
      timestamp: Date.now(),
    });
  }

  /**
   * Validate message structure
   */
  private isValidMessage(message: Message): boolean {
    if (!message || typeof message !== 'object') {
      return false;
    }

    if (message.type !== 'command') {
      return true; // Non-command messages don't need further validation
    }

    return Boolean(message.messageId && message.content);
  }

  /**
   * Handle built-in commands
   * @returns Returns true if built-in command was handled, otherwise false
   */
  private async handleBuiltInCommand(
    messageId: string,
    content: string
  ): Promise<boolean> {
    const trimmed = content.trim();

    // /status command
    if (trimmed === '/status') {
      const cwd = this.executor.getCurrentWorkingDirectory();
      const allowedDirs = this.directoryGuard.getAllowedDirectories();
      const threadInfo = this.threadManager
        ? `\n- Active Thread: ${this.threadManager.getActiveThread()?.name ?? 'none'} (${this.threadManager.listThreads().length}/${10} threads)`
        : '';

      this.sendResponse(messageId, {
        success: true,
        output: `📊 Status:
- Working Directory: ${cwd}
- Allowed Directories: ${allowedDirs.join(', ')}
- Connection: Active${threadInfo}`,
      });
      return true;
    }

    // /help command
    if (trimmed === '/help') {
      const threadHelp = this.threadManager
        ? `\n- /thread - List all threads\n- /thread new [name] - Create a new thread\n- /thread switch <name|id> - Switch active thread\n- /thread delete <name> - Delete a thread`
        : '';
      this.sendResponse(messageId, {
        success: true,
        output: `📖 Available commands:
- /help - Show this help message
- /status - Show current status
- /abort - Abort the currently executing command
- /clear - Clear conversation context
- /compact - Compress conversation history to reduce context size
- /cd <directory> - Change working directory
- /backend - List available AI backends and switch between them${threadHelp}
You can also use natural language commands to control Claude Code CLI.`,
      });
      return true;
    }

    // /clear command
    if (trimmed === '/clear') {
      this.executor.resetContext();
      this.sendResponse(messageId, {
        success: true,
        output: '✅ Conversation context cleared',
      });
      return true;
    }

    // /compact command - compress conversation history via Claude CLI's built-in /compact
    if (trimmed === '/compact') {
      if (!('compactWhenFull' in this.executor && typeof this.executor.compactWhenFull === 'function')) {
        this.sendResponse(messageId, {
          success: false,
          error: '/compact is not supported in this executor mode',
        });
        return true;
      }
      this.sendStreamChunk(messageId, '🗜️ Compressing conversation history...\n');
      const persistentExecutor = this.executor as IExecutor;
      const result = await persistentExecutor.compactWhenFull!((chunk: string) => {
        this.sendStreamChunk(messageId, chunk);
      });
      if (!result.success) {
        this.sendResponse(messageId, {
          success: false,
          error: result.error || 'Compaction failed',
        });
      } else {
        this.sendResponse(messageId, {
          success: true,
          output: '✅ Conversation history compressed',
        });
      }
      return true;
    }

    // /backend command
    if (trimmed === '/backend' || trimmed.startsWith('/backend ')) {
      await this.handleBackendCommand(messageId, trimmed);
      return true;
    }

    // /thread command
    if (trimmed === '/thread' || trimmed.startsWith('/thread ')) {
      await this.handleThreadCommand(messageId, trimmed);
      return true;
    }

    // /cd command
    if (trimmed.startsWith('/cd')) {
      const parts = trimmed.split(/\s+/);
      if (parts.length < 2) {
        this.sendResponse(messageId, {
          success: false,
          error: 'Usage: /cd <directory>',
        });
        return true;
      }

      const targetDir = parts.slice(1).join(' ');
      try {
        await this.executor.setWorkingDirectory(targetDir);
        const newCwd = this.executor.getCurrentWorkingDirectory();

        // Save lastWorkingDirectory to config (set() already saves)
        await this.config.set('lastWorkingDirectory', newCwd);

        // Sync working directory back to the active thread
        if (this.threadManager) {
          const active = this.threadManager.getActiveThread();
          if (active) {
            this.threadManager.updateWorkingDirectory(active.id, newCwd);
          }
        }

        this.sendResponse(messageId, {
          success: true,
          output: `✅ Changed working directory to: ${newCwd}`,
        });
      } catch (error) {
        this.sendResponse(messageId, {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : 'Failed to change directory',
        });
      }
      return true;
    }

    return false;
  }

  /**
   * Expand command shortcuts
   */
  private expandCommandShortcuts(content: string): string {
    const trimmed = content.trim();

    // Only expand when command is the entire content
    if (trimmed === '/r' || trimmed === '/resume') {
      return 'Please resume the previous conversation';
    }

    if (trimmed === '/c' || trimmed === '/continue') {
      return 'Please continue from where we left off';
    }

    return content;
  }

  /**
   * Execute passthrough slash command using local Claude CLI
   * This allows users to use their custom slash commands
   */
  private async executeSlashCommand(messageId: string, command: string): Promise<void> {
    return new Promise((resolve) => {
      const chunks: string[] = [];
      const errorChunks: string[] = [];

      console.log(`[MessageHandler] Spawning Claude CLI for command: ${command}`);

      // Spawn Claude CLI with the slash command
      // Use --print to get output and exit
      const child = spawn('claude', [command, '--print'], {
        cwd: this.executor.getCurrentWorkingDirectory(),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          CLAUDECODE: '', // Prevent nested session error
        },
      });

      // Handle stdout (stream chunks)
      child.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        chunks.push(chunk);
        this.sendStreamChunk(messageId, chunk);
      });

      // Handle stderr
      child.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        errorChunks.push(chunk);
        console.error(`[MessageHandler] Claude stderr: ${chunk}`);
      });

      // Handle process exit
      child.on('exit', (code) => {
        console.log(`[MessageHandler] Claude process exited with code: ${code}`);

        if (code === 0) {
          const output = chunks.join('');
          this.sendResponse(messageId, {
            success: true,
            output: output.trim() || '✅ Command executed successfully',
          });
        } else {
          const errorOutput = errorChunks.join('') || chunks.join('');
          this.sendResponse(messageId, {
            success: false,
            error: errorOutput.trim() || `Command failed with exit code ${code}`,
          });
        }
        resolve();
      });

      // Handle process error
      child.on('error', (error) => {
        console.error(`[MessageHandler] Failed to spawn Claude:`, error);
        this.sendResponse(messageId, {
          success: false,
          error: `Failed to execute command: ${error.message}`,
        });
        resolve();
      });
    });
  }

  /**
   * Execute Claude command
   */
  private async executeCommand(
    messageId: string,
    content: string
  ): Promise<void> {
    try {
      const result = await this.executor.execute(content, {
        onStream: (chunk: string) => {
          this.sendStreamChunk(messageId, chunk);
        },
        onToolUse: (toolUse: ToolUseInfo) => {
          this.sendToolUse(messageId, toolUse);
        },
        onToolResult: (toolResult: ToolResultInfo) => {
          this.sendToolResult(messageId, toolResult);
        },
        onRedactedThinking: () => {
          this.sendRedactedThinking(messageId);
        },
        onPlanMode: (planContent: string) => {
          this.sendPlanMode(messageId, planContent);
        },
      });

      // Only send success status, not the output
      // Output has already been streamed via onStream callback
      if (!result.success && result.error && result.error.includes('Prompt too long')) {
        if ('compactWhenFull' in this.executor && typeof this.executor.compactWhenFull === 'function') {
          // Context is full - use external compact which stops/restarts the process
          this.sendStreamChunk(messageId, '⚠️ Conversation history too long, auto-compressing...\n');
          const persistentExecutor = this.executor as IExecutor;
          const compactResult = await persistentExecutor.compactWhenFull!((chunk: string) => {
            this.sendStreamChunk(messageId, chunk);
          });
          if (!compactResult.success) {
            this.sendResponse(messageId, {
              success: false,
              error: `❌ Auto-compact failed: ${compactResult.error}\n\nUse /compact to try again, or /clear to start fresh.`,
            });
            return;
          }
          this.sendStreamChunk(messageId, '✅ Compressed. Retrying...\n');
          const retryResult = await this.executor.execute(content, {
            onStream: (chunk: string) => { this.sendStreamChunk(messageId, chunk); },
            onToolUse: (toolUse: ToolUseInfo) => { this.sendToolUse(messageId, toolUse); },
            onToolResult: (toolResult: ToolResultInfo) => { this.sendToolResult(messageId, toolResult); },
            onRedactedThinking: () => { this.sendRedactedThinking(messageId); },
            onPlanMode: (planContent: string) => { this.sendPlanMode(messageId, planContent); },
          });
          this.sendResponse(messageId, {
            success: retryResult.success,
            error: retryResult.error,
          });
          return;
        }
        this.sendResponse(messageId, {
          success: false,
          error: '❌ Conversation history too long.\n\nUse /compact to compress it, or /clear to start fresh.',
        });
        return;
      }
      this.sendResponse(messageId, {
        success: result.success,
        error: result.error,
      });
    } catch (error) {
      this.sendResponse(messageId, {
        success: false,
        error: error instanceof Error ? error.message : 'Execution error',
      });
    } finally {
      this.saveCurrentThreadState();
    }
  }

  /**
   * Send streaming output chunk
   */
  private sendStreamChunk(messageId: string, chunk: string): void {
    try {
      this.wsClient.send({
        type: 'stream',
        messageId,
        chunk,
        streamType: 'text',
        openId: this.currentOpenId,
        timestamp: Date.now(),
      });
    } catch (error) {
      // Ignore send errors, don't affect main flow
      console.error('Failed to send stream chunk:', error);
    }
  }

  /**
   * Send tool use event
   */
  private sendToolUse(messageId: string, toolUse: ToolUseInfo): void {
    try {
      this.wsClient.send({
        type: 'stream',
        messageId,
        streamType: 'tool_use',
        toolUse,
        openId: this.currentOpenId,
        timestamp: Date.now(),
      });
    } catch (error) {
      console.error('Failed to send tool use:', error);
    }
  }

  /**
   * Send tool result event
   */
  private sendToolResult(messageId: string, toolResult: ToolResultInfo): void {
    try {
      this.wsClient.send({
        type: 'stream',
        messageId,
        streamType: 'tool_result',
        toolResult,
        openId: this.currentOpenId,
        timestamp: Date.now(),
      });
    } catch (error) {
      console.error('Failed to send tool result:', error);
    }
  }

  /**
   * Send redacted thinking event
   * This occurs when AI reasoning is filtered by safety systems (Claude 3.7 Sonnet, Gemini)
   */
  private sendRedactedThinking(messageId: string): void {
    try {
      this.wsClient.send({
        type: 'stream',
        messageId,
        streamType: 'redacted_thinking',
        openId: this.currentOpenId,
        timestamp: Date.now(),
      });
    } catch (error) {
      console.error('Failed to send redacted thinking:', error);
    }
  }

  /**
   * Send plan mode event
   * Fired when Claude completes its plan between EnterPlanMode and ExitPlanMode tool calls.
   * Execution is auto-approved; this event is for user visibility only.
   */
  private sendPlanMode(messageId: string, planContent: string): void {
    try {
      this.wsClient.send({
        type: 'stream',
        messageId,
        streamType: 'plan_mode',
        planContent,
        openId: this.currentOpenId,
        timestamp: Date.now(),
      });
    } catch (error) {
      console.error('Failed to send plan mode:', error);
    }
  }

  /**
   * Send structured content for rich formatting
   */
  private sendStructuredContent(messageId: string, structuredContent: StructuredContent): void {
    try {
      this.wsClient.send({
        type: 'structured',
        messageId,
        structuredContent,
        openId: this.currentOpenId,
        timestamp: Date.now(),
        cwd: this.executor.getCurrentWorkingDirectory(),
      } as OutgoingMessage);
    } catch (error) {
      console.error('Failed to send structured content:', error);
    }
  }

  /**
   * Send response
   */
  private sendResponse(
    messageId: string,
    result: { success: boolean; output?: string; error?: string; sessionAbbr?: string }
  ): void {
    try {
      this.wsClient.send({
        type: 'response',
        messageId,
        success: result.success,
        output: result.output,
        error: result.error,
        sessionAbbr: result.sessionAbbr,
        openId: this.currentOpenId,
        timestamp: Date.now(),
        cwd: this.executor.getCurrentWorkingDirectory(),
        threads: this.threadManager?.getThreadSummaries(),
      });
    } catch (error) {
      console.error('Failed to send response:', error);
    }
  }

  /**
   * Detect whether a command is available on PATH
   */
  private checkCommand(cmd: string, args: string[]): Promise<boolean> {
    return new Promise((resolve) => {
      execFile(cmd, args, { timeout: 5000 }, (err) => resolve(!err));
    });
  }

  /**
   * Detect all installed AI backends
   */
  private async detectBackends(): Promise<BackendInfo[]> {
    const [claudeInstalled, geminiInstalled] = await Promise.all([
      this.checkCommand('claude', ['--version']),
      this.checkCommand('npx', ['--no', '@google/gemini-cli', '--version']),
    ]);

    return [
      { id: 'auto',   label: 'Claude Code', installed: claudeInstalled },
      { id: 'gemini', label: 'Gemini CLI',  installed: geminiInstalled },
    ];
  }

  /**
   * Handle /backend command
   * Usage:
   *   /backend              — list available backends
   *   /backend <name|index> — switch to the specified backend
   */
  private async handleBackendCommand(messageId: string, trimmed: string): Promise<void> {
    const parts = trimmed.split(/\s+/);
    const arg = parts[1];

    const currentConfig = (this.config.get('executor') as ExecutorConfig | undefined) ?? { type: 'auto' };
    const currentType = currentConfig.type;

    const backends = await this.detectBackends();
    const installed = backends.filter((b) => b.installed);

    // List mode
    if (!arg) {
      if (installed.length === 0) {
        this.sendResponse(messageId, {
          success: false,
          error: 'No supported AI backends found.\n\nMake sure Claude Code is installed: npm install -g @anthropic-ai/claude-code',
        });
        return;
      }

      const lines = installed.map((b, i) => {
        const isClaudeActive = b.id === 'auto' &&
          (currentType === 'auto' || currentType === 'claude-persistent' || currentType === 'claude-spawn');
        const active = b.id === currentType || isClaudeActive ? ' ★ (active)' : '';
        return `${i + 1}. ${b.label}${active}`;
      });

      this.sendResponse(messageId, {
        success: true,
        output: `🤖 Available AI backends:\n${lines.join('\n')}\n\nSwitch with: /backend <index> or /backend <name>`,
      });
      return;
    }

    // Switch mode — resolve by index or name
    const index = parseInt(arg, 10);
    let target: BackendInfo | undefined;

    if (!isNaN(index) && index >= 1 && index <= installed.length) {
      target = installed[index - 1];
    } else {
      target = installed.find(
        (b) => b.id === arg || b.label.toLowerCase().includes(arg.toLowerCase())
      );
    }

    if (!target) {
      this.sendResponse(messageId, {
        success: false,
        error: `Backend "${arg}" not found. Use /backend to see available options.`,
      });
      return;
    }

    // Persist to config
    const newConfig: ExecutorConfig = { ...currentConfig, type: target.id };
    await this.config.set('executor', newConfig);

    // Hot-swap executor without restart
    const cwd = this.executor.getCurrentWorkingDirectory();
    if (typeof (this.executor as any).destroy === 'function') {
      (this.executor as any).destroy();
    }
    this.executor = createExecutor(this.directoryGuard, newConfig, cwd);

    this.sendResponse(messageId, {
      success: true,
      output: `✅ Backend switched to: ${target.label}`,
    });
  }

  /**
   * Handle /thread commands
   * Usage:
   *   /thread                    — list threads
   *   /thread list               — list threads
   *   /thread new [name]         — create & switch to new thread
   *   /thread switch <name|id>   — switch active thread (also accepts UUID for card buttons)
   *   /thread delete <name>      — delete a thread
   */
  private async handleThreadCommand(messageId: string, trimmed: string): Promise<void> {
    if (!this.threadManager) {
      this.sendResponse(messageId, {
        success: false,
        error: '/thread commands are not available (thread manager not initialized)',
      });
      return;
    }

    const parts = trimmed.split(/\s+/);
    const sub = parts[1];

    // list
    if (!sub || sub === 'list') {
      const threads = this.threadManager.listThreads();
      const activeId = this.threadManager.getActiveThread()?.id;
      const lines = threads.map((t, i) => {
        const active = t.id === activeId ? ' ★' : '';
        const session = t.sessionId ? ` · ...${t.sessionId.slice(-8)}` : ' · No session';
        return `${i + 1}. **${t.name}**${active}${session}\n   📂 ${t.workingDirectory}`;
      });
      const maxThreads = 10;
      this.sendResponse(messageId, {
        success: true,
        output: `📋 Threads (${threads.length}/${maxThreads}):\n${lines.join('\n')}\n★ = active thread`,
      });
      return;
    }

    // new
    if (sub === 'new') {
      const name = parts[2]; // optional
      try {
        const thread = this.threadManager.createThread(name, this.executor.getCurrentWorkingDirectory());
        await this.applyThread(thread);
        this.sendResponse(messageId, {
          success: true,
          output: `✅ Created and switched to thread: **${thread.name}**\n📂 ${thread.workingDirectory}`,
        });
      } catch (error) {
        this.sendResponse(messageId, {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to create thread',
        });
      }
      return;
    }

    // switch
    if (sub === 'switch') {
      const identifier = parts[2];
      if (!identifier) {
        this.sendResponse(messageId, { success: false, error: 'Usage: /thread switch <name|id>' });
        return;
      }

      // Try by ID first (for card button clicks), then by name
      const thread =
        this.threadManager.getThread(identifier) ??
        this.threadManager.getThreadByName(identifier);

      if (!thread) {
        this.sendResponse(messageId, { success: false, error: `Thread "${identifier}" not found.` });
        return;
      }

      try {
        this.threadManager.switchThread(thread.id);
        await this.applyThread(thread);
        const sessionHint = thread.sessionId
          ? `\n🔗 Resuming session ...${thread.sessionId.slice(-8)}`
          : '\n🆕 No previous session';
        this.sendResponse(messageId, {
          success: true,
          output: `✅ Switched to thread: **${thread.name}**\n📂 ${thread.workingDirectory}${sessionHint}`,
        });
      } catch (error) {
        this.sendResponse(messageId, {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to switch thread',
        });
      }
      return;
    }

    // delete
    if (sub === 'delete') {
      const name = parts[2];
      if (!name) {
        this.sendResponse(messageId, { success: false, error: 'Usage: /thread delete <name>' });
        return;
      }

      const thread = this.threadManager.getThreadByName(name);
      if (!thread) {
        this.sendResponse(messageId, { success: false, error: `Thread "${name}" not found.` });
        return;
      }

      try {
        const wasActive = this.threadManager.getActiveThread()?.id === thread.id;
        this.threadManager.deleteThread(thread.id);

        if (wasActive) {
          const newActive = this.threadManager.getActiveThread();
          if (newActive) {
            await this.applyThread(newActive);
          }
          this.sendResponse(messageId, {
            success: true,
            output: `✅ Deleted thread: **${name}**\nSwitched to: **${newActive?.name ?? 'none'}**`,
          });
        } else {
          this.sendResponse(messageId, { success: true, output: `✅ Deleted thread: **${name}**` });
        }
      } catch (error) {
        this.sendResponse(messageId, {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to delete thread',
        });
      }
      return;
    }

    this.sendResponse(messageId, {
      success: false,
      error: `Unknown /thread subcommand: ${sub}\nUse: /thread [list|new|switch|delete]`,
    });
  }

  /**
   * Apply a thread's state to the executor (cwd + sessionId + sessionFilePath).
   */
  private async applyThread(thread: Thread): Promise<void> {
    if (!this.threadManager) return;

    // Sync session file and session ID before changing directory
    // (externalSessionManagement must be enabled so setWorkingDirectory won't reset them)
    const sessionId = this.threadManager.loadSessionId(thread.id);
    (this.executor as any).setSessionFilePath?.(this.threadManager.sessionFilePath(thread.id));
    (this.executor as any).setSessionId?.(sessionId);

    // Now change working directory (won't reset session because externalSessionManagement is on)
    if (this.executor.getCurrentWorkingDirectory() !== thread.workingDirectory) {
      try {
        await this.executor.setWorkingDirectory(thread.workingDirectory);
      } catch {
        // Directory may no longer exist; leave executor's cwd unchanged
      }
    }
  }

  /**
   * Save the executor's current session ID back to the active thread.
   */
  private saveCurrentThreadState(): void {
    if (!this.threadManager) return;
    const active = this.threadManager.getActiveThread();
    if (!active) return;

    // Read session ID from executor if exposed
    const execAny = this.executor as any;
    const sessionId: string | null =
      typeof execAny.getSessionId === 'function' ? execAny.getSessionId() : null;

    if (sessionId && sessionId !== active.sessionId) {
      this.threadManager.saveSessionId(active.id, sessionId);
      this.threadManager.updateSessionId(active.id, sessionId);
    }
    this.threadManager.touchActiveThread();
  }

  /**
   * Destroy handler
   */
  destroy(): void {
    this.isDestroyed = true;
    this.isExecuting = false;
    this.notificationAdapter.unregister();
  }
}
