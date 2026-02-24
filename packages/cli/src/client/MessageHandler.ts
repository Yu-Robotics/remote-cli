import { WebSocketClient } from './WebSocketClient';
import { DirectoryGuard } from '../security/DirectoryGuard';
import { IncomingMessage, OutgoingMessage, StructuredContent, ToolUseInfo, ToolResultInfo } from '../types';
import type { ClaudeExecutor, ClaudePersistentExecutor } from '../executor';
import { FeishuNotificationAdapter } from '../hooks';
import { ConfigManager } from '../config/ConfigManager';
import { processFileReadContent } from '../utils/FileReadDetector';
import { spawn } from 'child_process';

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
  private executor: ClaudeExecutor | ClaudePersistentExecutor;
  private directoryGuard: DirectoryGuard;
  private config: ConfigManager;
  private isDestroyed = false;
  private isExecuting = false;
  private currentOpenId?: string;
  private notificationAdapter: FeishuNotificationAdapter;

  constructor(
    wsClient: WebSocketClient,
    executor: ClaudeExecutor | ClaudePersistentExecutor,
    directoryGuard: DirectoryGuard,
    config: ConfigManager
  ) {
    this.wsClient = wsClient;
    this.executor = executor;
    this.directoryGuard = directoryGuard;
    this.config = config;

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

      this.sendResponse(messageId, {
        success: true,
        output: `📊 Status:
- Working Directory: ${cwd}
- Allowed Directories: ${allowedDirs.join(', ')}
- Connection: Active`,
      });
      return true;
    }

    // /help command
    if (trimmed === '/help') {
      this.sendResponse(messageId, {
        success: true,
        output: `📖 Available commands:
- /help - Show this help message
- /status - Show current status
- /abort - Abort the currently executing command
- /clear - Clear conversation context
- /cd <directory> - Change working directory
- /r or /resume - Resume previous conversation
- /c or /continue - Continue previous conversation
- /review - Review changes (supports remote interaction)

💡 Interactive commands like /review will prompt you for input via Feishu when needed.

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
      });

      // Only send success status, not the output
      // Output has already been streamed via onStream callback
      this.sendResponse(messageId, {
        success: result.success,
        error: result.error,
      });
    } catch (error) {
      this.sendResponse(messageId, {
        success: false,
        error: error instanceof Error ? error.message : 'Execution error',
      });
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
      });
    } catch (error) {
      console.error('Failed to send response:', error);
    }
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
